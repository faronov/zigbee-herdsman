/**
 * ZRHP request/response, events and the session lifecycle on top of the link (port of `zigpy_zrhp/api.py`).
 *
 * {@link ZrhpApi} allocates TIDs, matches responses, retries requests after a link resync with the `RETRY` flag (spec 6.5),
 * answers NCP-originated requests through a handler, and runs the session handshake: after every `ESTABLISHED` it waits for
 * `EVT_NCP_READY` and sends `SYS_NEGOTIATE` before releasing requests.
 */

import {randomInt} from "node:crypto";
import {logger} from "../../utils/logger";
import type {Codec, StructOf} from "./codec";
import {CodecError, encodeWith} from "./codec";
import {type Capacity, HostCaps, Kind, LinkEndpoint, Status, statusName} from "./consts";
import {type ByteStream, LinkDriver} from "./driver";
import {ResetReason} from "./frame";
import {type LinkConfig, LinkConfigs, type LinkEvent, PeerChange, TxFailure} from "./link";
import * as M from "./messages";

const NS = "zh:zrhp:api";

export const MAJOR = 1;
export const DEFAULT_TIMEOUT = 5000;
export const HOST_CAPS = HostCaps.FC_CHECKPOINTS | HostCaps.RETRY_CACHE;

/**
 * Response bytes the host lets the NCP owe per endpoint. The NCP queues its responses in a 1 536-byte buffer per endpoint
 * (1 024 on compact parts) and drops what does not fit, so the host bounds what it has in flight (spec 12.1.1 Z1).
 */
export const RESPONSE_BUDGET = 1024;
const DEFAULT_RESPONSE = 48;

function expectedResponse(msgId: number, payload: Buffer): number {
    switch (msgId) {
        case M.Id.SYS_ECHO:
            return 8 + payload.length;
        case M.Id.BKP_EXPORT_READ:
            return payload.length >= 4 ? 10 + payload.readUInt16LE(2) : DEFAULT_RESPONSE;
        case M.Id.DIAG_GET_COUNTERS:
        case M.Id.TBL_READ:
        case M.Id.GP_SINK_TABLE_READ:
        case M.Id.DIAG_GET_NEIGHBORS:
        case M.Id.DIAG_GET_ROUTES:
        case M.Id.DIAG_GET_CHILDREN:
        case M.Id.NWK_ACTIVE_SCAN:
        case M.Id.GP_PROXY_TABLE_READ:
        case M.Id.FW_GET_SLOTS:
        case M.Id.SYS_NEGOTIATE:
            return 640;
        default:
            return DEFAULT_RESPONSE;
    }
}

/** A weighted semaphore. */
class Budget {
    readonly capacity: number;
    used = 0;
    readonly #waiters: {weight: number; resolve: () => void}[] = [];

    constructor(capacity: number) {
        this.capacity = capacity;
    }

    async acquire(weight: number, timeoutMs: number): Promise<number> {
        const w = Math.min(weight, this.capacity);

        if (this.#waiters.length === 0 && this.used + w <= this.capacity) {
            this.used += w;
            return w;
        }

        await new Promise<void>((resolve, reject) => {
            const entry = {
                weight: w,
                resolve: (): void => {
                    clearTimeout(timer);
                    resolve();
                },
            };
            const timer = setTimeout(() => {
                const i = this.#waiters.indexOf(entry);

                if (i >= 0) {
                    this.#waiters.splice(i, 1);
                }

                reject(new Error("timeout"));
            }, timeoutMs);
            this.#waiters.push(entry);
        });

        return w;
    }

    release(weight: number): void {
        this.used -= weight;

        while (this.#waiters.length > 0 && this.used + this.#waiters[0].weight <= this.capacity) {
            const next = this.#waiters.shift() as {weight: number; resolve: () => void};
            this.used += next.weight;
            next.resolve();
        }
    }
}

/** A ZRHP request failed. */
export class ZrhpError extends Error {
    readonly msgId: number;
    readonly status: number;

    constructor(msgId: number, status: number, text?: string) {
        super(text ?? `${M.nameOf(msgId)} failed: ${statusName(status)}`);
        this.msgId = msgId;
        this.status = status;
    }
}

/** The session reset before the response arrived (outcome unknown). */
export class LinkResetError extends ZrhpError {}

/** The link to the NCP is down and was not re-established in time. */
export class SessionLost extends Error {}

/** What the NCP said in the last handshake. */
export class SessionInfo {
    readonly ncpCookie: number;
    readonly ready: StructOf<typeof M.EvtNcpReady.fields>;
    readonly negotiate: StructOf<typeof M.SysNegotiateRsp.fields>;
    readonly change: PeerChange;

    constructor(ready: StructOf<typeof M.EvtNcpReady.fields>, negotiate: StructOf<typeof M.SysNegotiateRsp.fields>, change: PeerChange) {
        this.ncpCookie = ready.ncpCookie;
        this.ready = ready;
        this.negotiate = negotiate;
        this.change = change;
    }

    hasCap(cap: bigint): boolean {
        return (this.negotiate.ncpCaps & cap) !== 0n;
    }

    capacity(cap: Capacity, def = 0): number {
        return this.negotiate.capacities.find((c) => c.id === cap)?.value ?? def;
    }

    get fwVersion(): string {
        return this.negotiate.fw.toString("utf8");
    }
}

interface Pending {
    msgId: number;
    tid: number;
    endpoint: LinkEndpoint;
    message: M.Message;
    resolve: (payload: Buffer) => void;
    reject: (error: Error) => void;
    done: boolean;
    /** the carrying frame failed with LINK_RESET */
    unknown: boolean;
    idempotentRetry: boolean;
    /** still queued when the session reset */
    unsent: boolean;
}

export type EventHandler = (msg: M.Message, body: unknown) => void;
export type RequestHandler = (msg: M.Message, body: unknown) => Promise<Buffer>;
export type SessionState = "lost" | "ready" | "portLost";
export type SessionHandler = (state: SessionState, info: SessionInfo | undefined) => void;

export interface RequestOptions {
    timeout?: number;
    /** statuses that do not throw (default: SUCCESS only) */
    allow?: number[];
    /** how long to wait for a session before failing (ms) */
    waitSession?: number;
    /** may be re-sent with RETRY after a resync (6.5) */
    retry?: boolean;
    /** called with the TID right before the request is queued */
    onSent?: (tid: number) => void;
}

export interface ZrhpApiOptions {
    linkConfig?: LinkConfig;
    hostCaps?: bigint;
    name?: string;
    cookieFactory?: () => number;
    handshakeTimeout?: number;
}

function randomCookie(): number {
    return randomInt(1, 0x100000000);
}

/** One host side of a ZRHP session. */
export class ZrhpApi {
    readonly #linkConfig: LinkConfig;
    readonly #hostCaps: bigint;
    readonly #name: Buffer;
    readonly #cookieFactory: () => number;
    readonly #handshakeTimeout: number;
    driver: LinkDriver | undefined;
    session: SessionInfo | undefined;
    lastNcpCookie: number | undefined;
    #tid = 0;
    readonly #pending = new Map<string, Pending>();
    #ready = false;
    #readyWaiters: (() => void)[] = [];
    #ncpReady: ((ev: StructOf<typeof M.EvtNcpReady.fields>) => void) | undefined;
    #sessionGeneration = 0;
    #pendingChange: PeerChange = PeerChange.NEW;
    readonly #eventHandlers: EventHandler[] = [];
    readonly #sessionHandlers: SessionHandler[] = [];
    #requestHandler: RequestHandler | undefined;
    #closing = false;
    #hostCookieChanged = false;
    readonly #budgets = new Map<LinkEndpoint, Budget>();
    readonly counters = {msgBadBatch: 0, protocolErrors: 0, retriesAfterResync: 0, lostAfterRestart: 0, portReopened: 0};

    constructor(options: ZrhpApiOptions = {}) {
        this.#linkConfig = options.linkConfig ?? LinkConfigs.desktopHost();
        this.#hostCaps = options.hostCaps ?? HOST_CAPS;
        this.#name = Buffer.from(options.name ?? "zigbee-herdsman-zrhp").subarray(0, 32);
        this.#cookieFactory = options.cookieFactory ?? randomCookie;
        this.#handshakeTimeout = options.handshakeTimeout ?? 5000;
    }

    // #region Registration

    addEventHandler(handler: EventHandler): void {
        this.#eventHandlers.push(handler);
    }

    addSessionHandler(handler: SessionHandler): void {
        this.#sessionHandlers.push(handler);
    }

    /** Answer NCP-originated requests (`TBL_LOOKUP`, `TBL_WRITEBACK`). */
    setRequestHandler(handler: RequestHandler): void {
        this.#requestHandler = handler;
    }

    // #endregion

    // #region Lifecycle

    get isReady(): boolean {
        return this.#ready;
    }

    get handshakeRxFrames(): number {
        return this.driver?.link.counters.rxFrames ?? 0;
    }

    /** Start the link over `stream` and complete handshake + negotiation. */
    async connect(stream: ByteStream): Promise<SessionInfo> {
        this.#closing = false;
        this.driver?.stop();
        this.driver = new LinkDriver(stream, this.#linkConfig, this.#cookieFactory(), (ev) => this.onLinkEvent(ev));
        this.driver.start(ResetReason.HOST_OPEN);

        try {
            await this.waitReady(this.#handshakeTimeout);
        } catch (error) {
            throw new SessionLost(`${(error as Error).message} (${this.handshakeDiag()})`);
        }

        return this.session as SessionInfo;
    }

    /** Bytes from the transport. */
    receive(data: Buffer): void {
        this.driver?.receive(data);
    }

    handshakeDiag(): string {
        const c = this.driver?.link.counters;

        if (!c) {
            return "no link";
        }

        return `rx ${c.rxBytes} B, ${c.rxFrames} frames, ${c.rxBadFrame} bad, ${c.rxStaleReset} stale resets, ${c.rxNotInSession} out of session`;
    }

    disconnect(): void {
        this.#closing = true;
        this.#ready = false;
        this.#sessionGeneration++;
        this.driver?.stop();
        this.failAll(new SessionLost("disconnected"));
    }

    async waitReady(timeout: number | undefined): Promise<void> {
        if (this.#ready) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const timer =
                timeout === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.#readyWaiters = this.#readyWaiters.filter((w) => w !== done);
                          reject(new SessionLost("no ZRHP session with the NCP"));
                      }, timeout);
            const done = (): void => {
                clearTimeout(timer);
                resolve();
            };
            this.#readyWaiters.push(done);
        });
    }

    /** The port was reopened (USJ re-enumeration): redo the handshake with a new host cookie. */
    reopened(stream: ByteStream): void {
        if (!this.driver) {
            return;
        }

        this.driver.stream = stream;
        this.sessionLost();
        this.#hostCookieChanged = true;
        this.driver.restart(this.#cookieFactory(), ResetReason.HOST_OPEN);
        this.counters.portReopened++;
    }

    /** The serial port vanished. */
    portLost(error?: Error): void {
        if (this.#closing) {
            return;
        }

        logger.warning(`Serial port lost: ${error?.message ?? "closed"}`, NS);
        this.sessionLost();

        for (const h of this.#sessionHandlers) {
            h("portLost", undefined);
        }
    }

    // #endregion

    // #region Requests

    private nextTid(): number {
        for (;;) {
            this.#tid = (this.#tid + 1) & 0xffff;

            if (this.#tid !== 0 && ![...this.#pending.values()].some((p) => p.tid === this.#tid)) {
                return this.#tid;
            }
        }
    }

    /** Send a typed request and return `[status, response body]`; throws {@link ZrhpError} unless the status is allowed. */
    async request<T, R>(
        msgId: M.Id,
        codec: Codec<T>,
        value: T,
        rspCodec?: Codec<R>,
        options: RequestOptions = {},
    ): Promise<[status: number, body: R | undefined]> {
        const raw = await this.requestRaw(msgId, encodeWith(codec, value), options);
        const [status, body] = M.decodeResponse(rspCodec, raw);

        if (!(options.allow ?? [Status.SUCCESS]).includes(status)) {
            throw new ZrhpError(msgId, status);
        }

        return [status, body];
    }

    /** Send a raw request; returns the raw response payload (status first). */
    async requestRaw(msgId: number, payload: Buffer, options: RequestOptions = {}): Promise<Buffer> {
        const endpoint = M.homeEndpoint(msgId);

        if (endpoint === undefined) {
            throw new Error(`no home endpoint for ${M.nameOf(msgId)}`);
        }

        if (payload.length > M.MAX_MESSAGE_PAYLOAD) {
            throw new Error("payload too large");
        }

        const timeout = options.timeout ?? DEFAULT_TIMEOUT;

        if (!this.#ready) {
            if (!this.driver || this.#closing) {
                throw new SessionLost("not connected");
            }

            await this.waitReady(options.waitSession ?? 30_000);
        }

        let budget = this.#budgets.get(endpoint);

        if (!budget) {
            budget = new Budget(RESPONSE_BUDGET);
            this.#budgets.set(endpoint, budget);
        }

        let weight: number;

        try {
            weight = await budget.acquire(expectedResponse(msgId, payload), timeout);
        } catch {
            throw new ZrhpError(msgId, Status.TIMEOUT, `${M.nameOf(msgId)} timed out`);
        }

        const tid = this.nextTid();
        const message: M.Message = {kind: Kind.REQUEST, msgId, tid, payload};
        const key = `${msgId}:${tid}`;
        let timer: NodeJS.Timeout | undefined;

        try {
            return await new Promise<Buffer>((resolve, reject) => {
                const pending: Pending = {
                    msgId,
                    tid,
                    endpoint,
                    message,
                    resolve: (p) => {
                        pending.done = true;
                        resolve(p);
                    },
                    reject: (e) => {
                        pending.done = true;
                        reject(e);
                    },
                    done: false,
                    unknown: false,
                    idempotentRetry: options.retry ?? true,
                    unsent: false,
                };
                this.#pending.set(key, pending);
                timer = setTimeout(() => pending.reject(new ZrhpError(msgId, Status.TIMEOUT, `${M.nameOf(msgId)} timed out`)), timeout);
                options.onSent?.(tid);

                if (!this.driver) {
                    pending.reject(new SessionLost("not connected"));
                    return;
                }

                this.driver.send(endpoint, M.encodeMessage(message));
            });
        } finally {
            clearTimeout(timer);
            this.#pending.delete(key);
            budget.release(weight);
        }
    }

    sendResponse(endpoint: LinkEndpoint, msgId: number, tid: number, payload: Buffer): void {
        this.driver?.send(endpoint, M.encodeMessage({kind: Kind.RESPONSE, msgId, tid, payload}));
    }

    private failAll(error: Error): void {
        for (const p of this.#pending.values()) {
            if (!p.done) {
                p.reject(error);
            }
        }

        this.#pending.clear();
    }

    // #endregion

    // #region Link events

    private onLinkEvent(ev: LinkEvent): void {
        switch (ev.type) {
            case "data":
                this.onData(ev.endpoint, ev.payload);
                break;
            case "txFailed":
                this.onTxFailed(ev.payload, ev.reason);
                break;
            case "peerReset":
                logger.info(`NCP link reset: ${ev.change} (cookie 0x${ev.cookie.toString(16)})`, NS);
                this.#pendingChange = ev.change;
                this.sessionLost();
                break;
            case "linkDown":
            case "linkFailed":
                logger.warning(`ZRHP link ${ev.type === "linkDown" ? "down" : "failed"}`, NS);
                this.sessionLost();
                break;
            case "established":
                logger.debug(`ZRHP session established: ${JSON.stringify(ev.session)}`, NS);
                this.negotiateSession();
                break;
        }
    }

    private sessionLost(): void {
        const wasReady = this.#ready;
        this.#ready = false;
        this.#sessionGeneration++;
        this.#ncpReady = undefined;

        if (this.driver) {
            // Nothing may precede SYS_NEGOTIATE in the next session (5.5).
            for (const [, raw] of this.driver.queues.clear()) {
                for (const msg of safeBatch(raw)) {
                    const p = msg.kind === Kind.REQUEST ? this.#pending.get(`${msg.msgId}:${msg.tid}`) : undefined;

                    if (p) {
                        p.unsent = true;
                    }
                }
            }
        }

        if (wasReady) {
            for (const h of this.#sessionHandlers) {
                h("lost", undefined);
            }
        }
    }

    private onTxFailed(payload: Buffer, reason: TxFailure): void {
        for (const msg of safeBatch(payload)) {
            if (msg.kind !== Kind.REQUEST) {
                continue;
            }

            const p = this.#pending.get(`${msg.msgId}:${msg.tid}`);

            if (!p || p.done) {
                continue;
            }

            if (reason === TxFailure.REJECTED) {
                p.reject(new ZrhpError(msg.msgId, Status.LINK_REJECTED, "frame rejected by the NCP"));
            } else {
                p.unknown = true;
            }
        }
    }

    private onData(endpoint: LinkEndpoint, payload: Buffer): void {
        let msgs: M.Message[];

        try {
            msgs = M.parseBatch(payload);
        } catch (error) {
            this.counters.msgBadBatch++;
            logger.warning(`Malformed batch on endpoint ${endpoint}: ${(error as Error).message}`, NS);
            return;
        }

        for (const msg of msgs) {
            if (msg.kind === Kind.RESPONSE) {
                const p = this.#pending.get(`${msg.msgId}:${msg.tid}`);

                if (p && !p.done) {
                    p.resolve(msg.payload);
                } else {
                    logger.debug(`Unmatched response ${M.nameOf(msg.msgId)} tid=${msg.tid}`, NS);
                }
            } else if (msg.kind === Kind.EVENT) {
                this.onEvent(msg);
            } else {
                this.onNcpRequest(endpoint, msg);
            }
        }
    }

    private onEvent(msg: M.Message): void {
        let body: unknown;

        try {
            body = M.decodeMessage(msg);
        } catch (error) {
            this.counters.protocolErrors++;
            logger.warning(`Undecodable event ${M.nameOf(msg.msgId)}: ${(error as Error).message} (${msg.payload.toString("hex")})`, NS);
            return;
        }

        if (msg.msgId === M.Id.EVT_NCP_READY) {
            this.#ncpReady?.(body as StructOf<typeof M.EvtNcpReady.fields>);
            return;
        }

        if (msg.msgId === M.Id.EVT_PROTOCOL_ERROR) {
            this.counters.protocolErrors++;
            logger.warning(`NCP reports a protocol error: ${JSON.stringify(body)}`, NS);
        }

        for (const h of this.#eventHandlers) {
            try {
                h(msg, body);
            } catch (error) {
                logger.error(`Event handler failed for ${M.nameOf(msg.msgId)}: ${(error as Error).stack}`, NS);
            }
        }
    }

    private onNcpRequest(endpoint: LinkEndpoint, msg: M.Message): void {
        const answer = async (): Promise<void> => {
            let payload: Buffer;
            let body: unknown;

            try {
                body = M.decodeMessage(msg);
            } catch (error) {
                if (!(error instanceof CodecError)) {
                    throw error;
                }

                this.sendResponse(endpoint, msg.msgId, msg.tid, Buffer.from([Status.INVALID_PARAMETER]));
                return;
            }

            if (!this.#requestHandler || body === undefined) {
                payload = Buffer.from([Status.UNSUPPORTED_COMMAND]);
            } else {
                try {
                    payload = await this.#requestHandler(msg, body);
                } catch (error) {
                    logger.error(`NCP request ${M.nameOf(msg.msgId)} failed: ${(error as Error).message}`, NS);
                    payload = Buffer.from([Status.FAILURE]);
                }
            }

            this.sendResponse(endpoint, msg.msgId, msg.tid, payload);
        };

        answer().catch((error) => logger.error(`NCP request ${M.nameOf(msg.msgId)}: ${error}`, NS));
    }

    // #endregion

    // #region Session

    private negotiateSession(): void {
        const generation = ++this.#sessionGeneration;
        const change = this.#pendingChange;

        this.doNegotiate(generation, change).catch((error) => {
            if (generation !== this.#sessionGeneration) {
                return; // superseded by a newer session
            }

            logger.warning(`ZRHP session setup failed: ${(error as Error).message}`, NS);

            if (this.driver && !this.#closing) {
                // Restart the handshake; the NCP repeats EVT_NCP_READY.
                this.driver.restart(this.driver.link.cookie, ResetReason.PROTOCOL_ERROR);
            }
        });
    }

    private async withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;

        try {
            return await Promise.race([
                p,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async doNegotiate(generation: number, change: PeerChange): Promise<void> {
        const ready = await this.withTimeout(
            new Promise<StructOf<typeof M.EvtNcpReady.fields>>((resolve) => {
                this.#ncpReady = resolve;
            }),
            this.#handshakeTimeout,
            "EVT_NCP_READY",
        );
        this.#ncpReady = undefined;

        // SYS_NEGOTIATE goes out before anything else, bypassing the gate.
        const tid = this.nextTid();
        const message: M.Message = {
            kind: Kind.REQUEST,
            msgId: M.Id.SYS_NEGOTIATE,
            tid,
            payload: M.SysNegotiateReq.encode({majorMin: MAJOR, majorMax: MAJOR, hostCaps: this.#hostCaps, name: this.#name}),
        };
        const key = `${M.Id.SYS_NEGOTIATE}:${tid}`;
        let raw: Buffer;

        try {
            raw = await this.withTimeout(
                new Promise<Buffer>((resolve, reject) => {
                    const p: Pending = {
                        msgId: M.Id.SYS_NEGOTIATE,
                        tid,
                        endpoint: LinkEndpoint.SYSTEM,
                        message,
                        resolve: (b) => {
                            p.done = true;
                            resolve(b);
                        },
                        reject: (e) => {
                            p.done = true;
                            reject(e);
                        },
                        done: false,
                        unknown: false,
                        idempotentRetry: false,
                        unsent: false,
                    };
                    this.#pending.set(key, p);
                    this.driver?.send(LinkEndpoint.SYSTEM, M.encodeMessage(message));
                }),
                this.#handshakeTimeout,
                "SYS_NEGOTIATE",
            );
        } finally {
            this.#pending.delete(key);
        }

        const [status, rsp] = M.decodeResponse(M.SysNegotiateRsp, raw);

        if (status !== Status.SUCCESS || rsp === undefined) {
            throw new ZrhpError(M.Id.SYS_NEGOTIATE, status);
        }

        if (rsp.major !== MAJOR) {
            throw new ZrhpError(M.Id.SYS_NEGOTIATE, Status.VERSION_MISMATCH);
        }

        if (generation !== this.#sessionGeneration) {
            return;
        }

        if (this.lastNcpCookie !== undefined) {
            if (change === PeerChange.NEW) {
                change = ready.ncpCookie === this.lastNcpCookie ? PeerChange.RESYNC : PeerChange.RESTARTED;
            }

            if (ready.ncpCookie !== this.lastNcpCookie) {
                change = PeerChange.RESTARTED;
            }
        }

        this.lastNcpCookie = ready.ncpCookie;
        this.session = new SessionInfo(ready, rsp, change);
        this.#pendingChange = PeerChange.NEW;
        this.resolveUnknown(change);
        this.#ready = true;

        for (const w of this.#readyWaiters.splice(0)) {
            w();
        }

        logger.info(
            `ZRHP session ready: NCP fw ${this.session.fwVersion}, cookie 0x${ready.ncpCookie.toString(16)}, network_state ${ready.networkState} (${change})`,
            NS,
        );

        for (const h of this.#sessionHandlers) {
            h("ready", this.session);
        }
    }

    /** Requests still pending when the session reset (spec 6.5). */
    private resolveUnknown(change: PeerChange): void {
        // The retry cache belongs to the cookie pair: RETRY only when neither cookie changed (12.1.1 Z7).
        const cacheValid = change === PeerChange.RESYNC && !this.#hostCookieChanged;
        this.#hostCookieChanged = false;

        for (const p of this.#pending.values()) {
            if (p.done || p.msgId === M.Id.SYS_NEGOTIATE) {
                continue;
            }

            if (p.unsent && !p.unknown) {
                p.unsent = false;
                this.driver?.send(p.endpoint, M.encodeMessage(p.message));
            } else if (cacheValid && p.idempotentRetry) {
                // The NCP retry cache answers it if it already ran.
                this.counters.retriesAfterResync++;
                p.unknown = false;
                p.message.retry = true;
                this.driver?.send(p.endpoint, M.encodeMessage(p.message));
            } else {
                this.counters.lostAfterRestart++;
                p.reject(new LinkResetError(p.msgId, Status.LINK_RESET, "NCP restarted, delivery unknown"));
            }
        }
    }

    // #endregion
}

function safeBatch(raw: Buffer): M.Message[] {
    try {
        return M.parseBatch(raw);
    } catch {
        return [];
    }
}

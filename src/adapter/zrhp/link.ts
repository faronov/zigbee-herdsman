/**
 * ZRHP link layer (spec 5): sessions, selective-repeat ARQ, credits, keepalive.
 *
 * {@link Link} is a sans-IO state machine and a line-by-line port of the Rust reference `zigbee_zrhp::link`
 * (`zigbee-zrhp/src/link/engine.rs`) through its Python port (`zigpy_zrhp/link.py`). It never reads a clock: every call takes
 * a monotonic time in microseconds. The caller moves bytes between the link and the transport:
 *
 *     transport RX bytes -> Link.pushRx -> Link.pollEvent -> upper layer
 *     upper-layer queues (TxSource) <- Link.pollTransmit -> transport TX bytes
 *     sleep until Link.nextDeadline()
 */

import {CobsAccumulator} from "./cobs";
import {BY_PRIORITY, DATA_ENDPOINTS, isBulkClass, LinkEndpoint, NEP} from "./consts";
import {
    type AckBody,
    type Credits,
    encodeAckBody,
    encodeRejectBody,
    encodeResetBody,
    encodeWire,
    type FrameError,
    FrameType,
    type Header,
    header,
    MAX_PAYLOAD,
    parseAckBody,
    parseFrame,
    parseRejectBody,
    parseResetBody,
    type RejectBody,
    RejectReason,
    type ResetBody,
    ResetReason,
    Role,
    resetBody,
    sessionEpoch,
} from "./frame";

/** Received-bitmap span (`ack+1 .. ack+32`) and duplicate window. */
export const SACK_SPAN = 32;
/** Idle time after which a `0x00` precedes the next frame (5.1). */
const RESYNC_IDLE_US = 100_000;
/** Rate limit of REJECT `STALE_EPOCH` / `UNSUPPORTED` (5.5). */
const REJECT_RATE_US = 100_000;
/** Anti-starvation threshold (5.10). */
const STARVATION_FRAMES = 8;
const REJECT_QUEUE = 4;
const CTL_QUEUE = 4;

export interface LinkConfig {
    role: Role;
    rxWindow: number;
    ackDelayUs: number;
    keepaliveMs: number;
    linkTimeoutMs: number;
    rtoInitialUs: number;
    rtoMinUs: number;
    rtoMaxUs: number;
    adaptiveRto: boolean;
    nRetxMax: number;
    resetRetryMs: number;
    resetRetryMaxMs: number;
    /** Initial credit granted to the peer, indexed by endpoint ID (0 unused). */
    initialCredits: number[];
    /** Return a delivered frame's credit when the next event is polled. */
    autoCredit: boolean;
}

function baseConfig(): LinkConfig {
    return {
        role: Role.HOST,
        rxWindow: 32,
        ackDelayUs: 1000,
        keepaliveMs: 500,
        linkTimeoutMs: 3000,
        rtoInitialUs: 100_000,
        rtoMinUs: 25_000,
        rtoMaxUs: 1_000_000,
        adaptiveRto: true,
        nRetxMax: 10,
        resetRetryMs: 200,
        resetRetryMaxMs: 2000,
        initialCredits: [0, 4, 8, 4, 4, 2],
        autoCredit: true,
    };
}

export const LinkConfigs = {
    ncp: (): LinkConfig => ({...baseConfig(), role: Role.NCP, rxWindow: 16, initialCredits: [0, 4, 8, 4, 2, 0]}),
    desktopHost: (): LinkConfig => ({...baseConfig(), role: Role.HOST, rxWindow: 32, initialCredits: [0, 4, 8, 4, 4, 2]}),
    embeddedHost: (): LinkConfig => ({...baseConfig(), role: Role.HOST, rxWindow: 8, initialCredits: [0, 4, 8, 4, 2, 0]}),
};

export enum LinkState {
    UNSYNCED = "unsynced",
    RESETTING = "resetting",
    ESTABLISHED = "established",
}

/** How a received `RESET_*` relates to the last known peer cookie. */
export enum PeerChange {
    NEW = "new",
    /** PEER_RESTARTED */
    RESTARTED = "restarted",
    /** PEER_RESYNC */
    RESYNC = "resync",
}

export interface SessionInfo {
    epoch: number;
    ownCookie: number;
    peerCookie: number;
    txWindow: number;
    peerRxMtu: number;
    keepaliveMs: number;
    linkTimeoutMs: number;
}

export enum TxFailure {
    LINK_RESET = "link_reset",
    REJECTED = "rejected",
}

export type LinkEvent =
    | {type: "peerReset"; cookie: number; change: PeerChange}
    | {type: "linkDown"}
    | {type: "linkFailed"}
    | {type: "established"; session: SessionInfo}
    | {type: "data"; endpoint: LinkEndpoint; payload: Buffer}
    | {type: "txFailed"; endpoint: LinkEndpoint; payload: Buffer; reason: TxFailure; rejectReason?: number};

/** Supplies whole batched messages per endpoint (spec 5.10). */
export interface TxSource {
    ready(endpoint: LinkEndpoint): boolean;
    fill(endpoint: LinkEndpoint, mtu: number): Buffer;
}

export const NO_SOURCE: TxSource = {
    ready: () => false,
    fill: () => Buffer.alloc(0),
};

/** Link counters (spec 5.12). */
export const COUNTER_IDS = {
    txFrames: 0x0101,
    txBytes: 0x0102,
    txRetransmissions: 0x0103,
    txRtoExpiries: 0x0104,
    txRejected: 0x0105,
    txBlockedCreditMs: 0x0106,
    txBlockedWindowMs: 0x0107,
    txDiscardedNoHost: 0x0108,
    naksSent: 0x0109,
    naksReceived: 0x010a,
    sessionsEstablished: 0x010b,
    linkDownEvents: 0x010c,
    rxFrames: 0x0111,
    rxBytes: 0x0112,
    rxBadFrame: 0x0113,
    rxDuplicate: 0x0114,
    rxOutOfOrder: 0x0115,
    rxEpochMismatch: 0x0116,
    rxNotInSession: 0x0117,
    rxRejectedSent: 0x0118,
    rxOverflow: 0x0119,
    rxStaleReset: 0x011a,
    peerRestarted: 0x011b,
    peerResync: 0x011c,
} as const;

export type LinkCounterName = keyof typeof COUNTER_IDS;
export type LinkCounters = Record<LinkCounterName, number>;

function newCounters(): LinkCounters {
    const out = {} as LinkCounters;

    for (const k of Object.keys(COUNTER_IDS) as LinkCounterName[]) {
        out[k] = 0;
    }

    return out;
}

type TxSlotState = "free" | "inflight" | "failed";

class TxSlot {
    state: TxSlotState = "free";
    failure: TxFailure | undefined;
    rejectReason: number | undefined;
    seq = 0;
    endpoint = 0;
    epSeq = 0;
    payload: Buffer = Buffer.alloc(0);
    sacked = false;
    needsRetx = false;
    retxPoll = false;
    retxCount = 0;
    firstTx = 0;
    lastTx = 0;
    lastTxOrder = 0;
}

type RxSlotState = "free" | "buffered" | "tombstone" | "ready";

class RxSlot {
    state: RxSlotState = "free";
    order = 0;
    endpoint = 0;
    epSeq = 0;
    payload: Buffer = Buffer.alloc(0);
}

class Peer {
    rxWindow = 4;
    rxMtu = MAX_PAYLOAD;
    keepaliveMs = 500;
    linkTimeoutMs = 3000;
    credits: number[] = new Array(NEP).fill(0);
}

function toEndpoint(value: number): LinkEndpoint | undefined {
    return value >= 1 && value < NEP ? (value as LinkEndpoint) : undefined;
}

/** The ZRHP link state machine with `txw` transmit and `rxw` receive slots. */
export class Link {
    readonly cfg: LinkConfig;
    readonly counters: LinkCounters = newCounters();
    cookie: number;
    state: LinkState = LinkState.UNSYNCED;
    peerKnown: number | undefined;
    epoch = 0;

    private readonly txw: number;
    private readonly rxw: number;
    private readonly dec = new CobsAccumulator();
    private answered: number | undefined;
    private sessionPeer = 0;
    private peer = new Peer();
    private keepaliveUs = 500_000;
    private linkTimeoutUs = 3_000_000;
    private txWindow = 4;
    private resetReason = 0;
    private resetTx: "req" | "ack" | undefined;
    private resetRetryAt = 0;
    private resetRetryMs: number;
    private dupAckAt: number | undefined;
    private rxInSession = false;
    private anyTx = false;
    private lastTx = 0;
    private lastRxValid = 0;
    // Transmit ARQ.
    private readonly tx: TxSlot[];
    private nextSeq = 0;
    private base = 0;
    private txOrder = 0;
    private dMax: number | undefined;
    private nbadHandled = 0;
    private txCreditEdge: number[] = new Array(NEP).fill(0);
    private nextEpSeq: number[] = new Array(NEP).fill(0);
    private srtt: number | undefined;
    private rttvar = 0;
    private rto: number;
    private blockedSince: number | undefined;
    private blockedByWindow = false;
    private consecutiveHigh = 0;
    private lastServed: number[] = new Array(NEP).fill(0);
    private servedCounter = 0;
    // Receive ARQ.
    private readonly rx: RxSlot[];
    private rxAckSeq = 0;
    private rxBitmap = 0;
    private expectedEpSeq: number[] = new Array(NEP).fill(0);
    private rxCreditEdge: number[] = new Array(NEP).fill(0);
    private lastRxEpSeq: (number | undefined)[] = new Array(NEP).fill(undefined);
    private creditDirty = 0;
    private nbad = 0;
    private nbadReported = 0;
    private framesSinceAck = 0;
    private delayedAckAt: number | undefined;
    private ackReq: "ack" | "nak" | undefined;
    private keepaliveDue = false;
    private crcHoldoffUntil: number | undefined;
    private crcNakAfterHoldoff = false;
    private rejects: RejectBody[] = [];
    private lastStaleReject: number | undefined;
    private readyCounter = 0;
    // Upper-layer events.
    private ctl: LinkEvent[] = [];
    private establishedPending = false;
    private lent: ["tx" | "rx", number] | undefined;

    constructor(cfg: LinkConfig, cookie: number, txw = 32, rxw = 32) {
        if (txw < 1 || txw > 128) {
            throw new Error("txw must be 1..=128");
        }

        if (rxw < 4 || rxw > 32) {
            throw new Error("rxw must be 4..=32");
        }

        this.cfg = cfg;
        this.cookie = cookie;
        this.txw = txw;
        this.rxw = rxw;
        this.resetRetryMs = cfg.resetRetryMs;
        this.rto = cfg.rtoInitialUs;
        this.tx = Array.from({length: txw}, () => new TxSlot());
        this.rx = Array.from({length: rxw}, () => new RxSlot());
    }

    // #region Public API

    /** (Re)start the handshake: drop ARQ state, fail unacked frames. */
    open(now: number, reason: ResetReason = ResetReason.HOST_OPEN): void {
        this.dec.reset();
        this.beginReset(now, reason);
    }

    reopen(now: number, cookie: number, reason: ResetReason): void {
        this.cookie = cookie;
        this.open(now, reason);
    }

    session(): SessionInfo | undefined {
        return this.state === LinkState.ESTABLISHED ? this.sessionInfo() : undefined;
    }

    get rtoUs(): number {
        return this.rto;
    }

    get txBase(): number {
        return this.base;
    }

    get txNextSeq(): number {
        return this.nextSeq;
    }

    get rxAck(): number {
        return this.rxAckSeq;
    }

    txUnacked(): number[] {
        return this.tx.filter((s) => s.state === "inflight" && !s.sacked).map((s) => s.seq);
    }

    txInFlight(): number[] {
        return this.tx.filter((s) => s.state === "inflight").map((s) => s.seq);
    }

    canSend(endpoint: LinkEndpoint): boolean {
        return this.state === LinkState.ESTABLISHED && this.admissible(endpoint) && this.freeTxSlot() !== undefined;
    }

    /** Feed received bytes; returns how many were consumed. Stops early while delivered frames wait in {@link pollEvent}. */
    pushRx(data: Uint8Array, now: number): number {
        this.releaseLent();
        let i = 0;

        while (i < data.length) {
            if (this.hasReady()) {
                break;
            }

            const res = this.dec.push(data[i]);
            i++;

            if (res === undefined) {
                continue;
            }

            if (typeof res === "number") {
                this.onBadFrame(now);
            } else {
                this.onFrame(res, now);
            }
        }

        this.inc("rxBytes", i);

        return i;
    }

    /** A UART framing/parity/overrun error: abort the frame, count `nbad`. */
    onLineError(now: number, overrun = false): void {
        this.dec.lineError();

        if (overrun) {
            this.inc("rxOverflow");
        }

        this.onBadFrame(now);
    }

    pollEvent(): LinkEvent | undefined {
        this.releaseLent();

        const ctl = this.ctl.shift();

        if (ctl) {
            return ctl;
        }

        let failed: number | undefined;

        for (let i = 0; i < this.tx.length; i++) {
            const s = this.tx[i];

            if (s.state === "failed" && (failed === undefined || s.lastTxOrder < this.tx[failed].lastTxOrder)) {
                failed = i;
            }
        }

        if (failed !== undefined) {
            this.lent = ["tx", failed];
            const s = this.tx[failed];

            return {
                type: "txFailed",
                endpoint: toEndpoint(s.endpoint) ?? LinkEndpoint.LINK,
                payload: s.payload,
                reason: s.failure ?? TxFailure.LINK_RESET,
                rejectReason: s.rejectReason,
            };
        }

        if (this.establishedPending) {
            this.establishedPending = false;

            if (this.state === LinkState.ESTABLISHED) {
                return {type: "established", session: this.sessionInfo()};
            }
        }

        let ready: number | undefined;

        for (let i = 0; i < this.rx.length; i++) {
            const s = this.rx[i];

            if (s.state === "ready" && (ready === undefined || s.order < this.rx[ready].order)) {
                ready = i;
            }
        }

        if (ready === undefined) {
            return undefined;
        }

        this.lent = ["rx", ready];
        const s = this.rx[ready];

        return {type: "data", endpoint: s.endpoint as LinkEndpoint, payload: s.payload};
    }

    /** Return receive credits after the consumer freed buffers (rule R8). */
    releaseCredit(endpoint: LinkEndpoint, frames = 1): void {
        this.doReleaseCredit(endpoint, frames);
    }

    /** Next wire frame due at `now` (timers first), or `undefined`. */
    pollTransmit(now: number, src: TxSource): Buffer | undefined {
        this.releaseLent();
        this.handleTimers(now);

        return this.transmit(now, src);
    }

    nextDeadline(): number | undefined {
        if (this.state === LinkState.UNSYNCED) {
            return undefined;
        }

        if (this.state === LinkState.RESETTING) {
            return this.resetTx !== undefined ? 0 : this.resetRetryAt;
        }

        const immediate =
            this.resetTx !== undefined ||
            this.ackReq !== undefined ||
            this.keepaliveDue ||
            this.rejects.length > 0 ||
            this.tx.some((s) => s.state === "inflight" && s.needsRetx);

        if (immediate) {
            return 0;
        }

        let t = Math.min(this.lastRxValid + this.linkTimeoutUs, this.lastTx + this.keepaliveUs);

        if (this.delayedAckAt !== undefined) {
            t = Math.min(t, this.delayedAckAt);
        }

        if (this.crcNakAfterHoldoff && this.crcHoldoffUntil !== undefined) {
            t = Math.min(t, this.crcHoldoffUntil);
        }

        const i = this.oldestUnsacked();

        if (i !== undefined) {
            t = Math.min(t, this.tx[i].lastTx + this.rto);
        }

        if (this.blockedSince !== undefined) {
            t = Math.min(t, this.blockedSince + this.keepaliveUs);
        }

        return t;
    }

    // #endregion

    // #region Session

    private inc(name: LinkCounterName, n = 1): void {
        this.counters[name] = Math.min(0xffffffff, this.counters[name] + n);
    }

    private localRxWindow(): number {
        return Math.max(4, Math.min(this.cfg.rxWindow, this.rxw));
    }

    private sessionInfo(): SessionInfo {
        return {
            epoch: this.epoch,
            ownCookie: this.cookie,
            peerCookie: this.sessionPeer,
            txWindow: this.txWindow,
            peerRxMtu: this.peer.rxMtu,
            keepaliveMs: Math.floor(this.keepaliveUs / 1000),
            linkTimeoutMs: Math.floor(this.linkTimeoutUs / 1000),
        };
    }

    private beginReset(now: number, reason: number): void {
        this.failAllInflight();
        this.clearRx();
        this.state = LinkState.RESETTING;
        this.answered = undefined;
        this.resetReason = reason;
        this.resetTx = "req";
        this.resetRetryMs = this.cfg.resetRetryMs;
        this.resetRetryAt = now + this.resetRetryMs * 1000;
        this.anyTx = false;
    }

    private pushCtl(ev: LinkEvent): void {
        this.ctl.push(ev);

        if (this.ctl.length > CTL_QUEUE) {
            this.ctl.shift();
        }
    }

    private storePeer(body: ResetBody): void {
        const p = new Peer();

        for (const [ep, value] of body.credits) {
            const e = toEndpoint(ep);

            if (e !== undefined) {
                p.credits[e] = value;
            }
        }

        p.rxWindow = Math.max(4, Math.min(32, body.rxWindow));
        p.rxMtu = Math.min(body.rxMtu, MAX_PAYLOAD);
        p.keepaliveMs = Math.max(1, body.keepaliveMs);
        p.linkTimeoutMs = body.linkTimeoutMs;
        this.peer = p;
    }

    private onReset(type: FrameType, payload: Buffer, now: number): void {
        let body: ResetBody;

        try {
            body = parseResetBody(payload);
        } catch {
            this.inc("rxStaleReset");
            return;
        }

        const peerRole = this.cfg.role === Role.HOST ? Role.NCP : Role.HOST;

        if (body.role !== peerRole || body.cookie === 0 || body.linkVersion < 1) {
            this.inc("rxStaleReset");
            return;
        }

        const c = body.cookie;

        if (type === FrameType.RESET_REQ) {
            if (this.state === LinkState.RESETTING && this.answered === c) {
                // Retried request: our RESET_ACK was lost.
                this.storePeer(body);
                this.resetTx = "ack";
                return;
            }

            const change = this.notePeerCookie(c);
            this.storePeer(body);
            this.failAllInflight();
            this.clearRx();
            this.pushCtl({type: "peerReset", cookie: c, change});
            this.state = LinkState.RESETTING;
            this.answered = c;
            this.resetTx = "ack";
            this.resetRetryMs = this.cfg.resetRetryMs;
            this.resetRetryAt = now + this.resetRetryMs * 1000;
            return;
        }

        // RESET_ACK
        if (body.peerCookie !== this.cookie) {
            this.inc("rxStaleReset");
            return;
        }

        if (this.state === LinkState.ESTABLISHED && this.sessionPeer === c) {
            // Duplicate RESET_ACK: the peer is still RESETTING because our RESET_ACK was lost. Answer once more (rate-limited).
            if (!this.rxInSession && (this.dupAckAt === undefined || now >= this.dupAckAt + this.cfg.resetRetryMs * 1000)) {
                this.dupAckAt = now;
                this.resetTx = "ack";
            }

            return;
        }

        if (this.peerKnown !== c) {
            const change = this.notePeerCookie(c);
            this.failAllInflight();
            this.clearRx();
            this.pushCtl({type: "peerReset", cookie: c, change});
        }

        this.storePeer(body);

        if (this.answered !== c) {
            this.answered = c;
            this.resetTx = "ack";
        } else {
            this.resetTx = undefined;
        }

        this.establish(c, now);
    }

    private notePeerCookie(c: number): PeerChange {
        let change: PeerChange;

        if (this.peerKnown === undefined) {
            change = PeerChange.NEW;
        } else if (this.peerKnown === c) {
            change = PeerChange.RESYNC;
        } else {
            change = PeerChange.RESTARTED;
        }

        this.inc(change === PeerChange.RESYNC ? "peerResync" : "peerRestarted");
        this.peerKnown = c;

        return change;
    }

    private establish(peerCookie: number, now: number): void {
        this.state = LinkState.ESTABLISHED;
        this.sessionPeer = peerCookie;
        const [h, n] = this.cfg.role === Role.HOST ? [this.cookie, peerCookie] : [peerCookie, this.cookie];
        this.epoch = sessionEpoch(h, n);
        this.nextSeq = 0;
        this.base = 0;
        this.dMax = undefined;
        this.nbadHandled = 0;
        this.txCreditEdge = [...this.peer.credits];
        this.nextEpSeq = new Array(NEP).fill(0);
        this.srtt = undefined;
        this.rttvar = 0;
        this.rto = this.cfg.rtoInitialUs;
        this.blockedSince = undefined;
        this.consecutiveHigh = 0;
        this.rxAckSeq = 0;
        this.rxBitmap = 0;
        this.expectedEpSeq = new Array(NEP).fill(0);
        this.rxCreditEdge = [...this.cfg.initialCredits, ...new Array(NEP).fill(0)].slice(0, NEP);
        this.rxCreditEdge[0] = 0;
        this.lastRxEpSeq = new Array(NEP).fill(undefined);
        this.creditDirty = 0;
        this.nbad = 0;
        this.nbadReported = 0;
        this.framesSinceAck = 0;
        this.delayedAckAt = undefined;
        this.ackReq = undefined;
        this.keepaliveDue = false;
        this.crcHoldoffUntil = undefined;
        this.crcNakAfterHoldoff = false;
        this.rejects = [];
        const ka = Math.max(1, Math.min(this.cfg.keepaliveMs, this.peer.keepaliveMs));
        this.keepaliveUs = ka * 1000;
        const lt = Math.max(this.cfg.linkTimeoutMs, this.peer.linkTimeoutMs, 3 * ka);
        this.linkTimeoutUs = lt * 1000;
        this.txWindow = Math.min(this.peer.rxWindow, Math.min(this.txw, 32));
        this.lastRxValid = now;
        this.lastTx = now;
        this.rxInSession = false;
        this.dupAckAt = undefined;
        this.establishedPending = true;
        this.inc("sessionsEstablished");
    }

    private failAllInflight(): void {
        for (const s of this.tx) {
            if (s.state === "inflight") {
                s.state = "failed";
                s.failure = TxFailure.LINK_RESET;
                s.rejectReason = undefined;
                s.needsRetx = false;
            }
        }
    }

    private clearRx(): void {
        // Ready frames were accepted (and possibly acknowledged); they are still delivered. Buffered frames were at most sacked.
        for (const s of this.rx) {
            if (s.state === "buffered" || s.state === "tombstone") {
                s.state = "free";
            }
        }

        this.rxBitmap = 0;
    }

    private linkFailed(now: number, reason: ResetReason): void {
        this.pushCtl({type: "linkFailed"});
        this.beginReset(now, reason);
    }

    // #endregion

    // #region Receive

    private hasReady(): boolean {
        return this.rx.some((s) => s.state === "ready");
    }

    private onBadFrame(now: number): void {
        this.inc("rxBadFrame");
        this.nbad = Math.min(255, this.nbad + 1);

        if (this.state !== LinkState.ESTABLISHED) {
            return;
        }

        const t = this.crcHoldoffUntil;

        if (t !== undefined && now < t) {
            this.crcNakAfterHoldoff = true;
        } else {
            this.ackReq = "nak";
            this.crcHoldoffUntil = now + this.cfg.ackDelayUs;
            this.crcNakAfterHoldoff = false;
        }
    }

    private queueReject(body: RejectBody): void {
        if (this.rejects.length < REJECT_QUEUE) {
            this.rejects.push(body);
            this.inc("rxRejectedSent");
        }
    }

    private onFrame(decoded: Buffer, now: number): void {
        let f: ReturnType<typeof parseFrame>;

        try {
            f = parseFrame(decoded);
        } catch (error) {
            if ((error as FrameError).isNoise) {
                this.onBadFrame(now);
                return;
            }

            // Valid CRC: a peer bug or version mismatch, not noise.
            this.nbad = 0;

            if (this.state === LinkState.ESTABLISHED && this.staleRejectAllowed(now)) {
                this.queueReject({seq: decoded[3], endpoint: decoded[2], epSeq: decoded[5], reason: RejectReason.UNSUPPORTED});
            }

            return;
        }

        this.inc("rxFrames");
        this.nbad = 0;
        const h = f.header;

        if (h.type === FrameType.RESET_REQ || h.type === FrameType.RESET_ACK) {
            this.onReset(h.type, f.payload, now);
            return;
        }

        if (this.state !== LinkState.ESTABLISHED) {
            this.inc("rxNotInSession");
            return;
        }

        if (h.epoch !== this.epoch) {
            this.inc("rxEpochMismatch");

            if (h.type === FrameType.DATA && this.staleRejectAllowed(now)) {
                this.queueReject({seq: h.seq, endpoint: h.endpoint, epSeq: h.epSeq, reason: RejectReason.STALE_EPOCH});
            }

            return;
        }

        this.lastRxValid = now;
        this.rxInSession = true;

        if (h.type === FrameType.DATA) {
            this.processAck(h.ack, undefined, now);
            this.onData(h, f.payload, now);
        } else if (h.type === FrameType.ACK || h.type === FrameType.NAK) {
            let body: AckBody;

            try {
                body = parseAckBody(f.payload);
            } catch {
                return;
            }

            for (const [ep, value] of body.credits) {
                const e = toEndpoint(ep);

                if (e !== undefined) {
                    this.txCreditEdge[e] = value;
                }
            }

            this.processAck(h.ack, body.sack, now);

            if (h.type === FrameType.NAK) {
                this.inc("naksReceived");
                this.processNbad(body.nbad);
            }
        } else {
            // REJECT
            try {
                this.onReject(parseRejectBody(f.payload), now);
            } catch {
                // truncated body: ignored
            }

            if (this.state === LinkState.ESTABLISHED) {
                this.processAck(h.ack, undefined, now);
            }
        }

        if (h.poll && this.state === LinkState.ESTABLISHED) {
            if (this.ackReq === undefined) {
                this.ackReq = "ack";
            }
        }
    }

    private staleRejectAllowed(now: number): boolean {
        if (this.lastStaleReject === undefined || now >= this.lastStaleReject + REJECT_RATE_US) {
            this.lastStaleReject = now;
            return true;
        }

        return false;
    }

    private requestAck(kind: "ack" | "nak"): void {
        if (kind === "nak" || this.ackReq === undefined) {
            this.ackReq = kind;
        }
    }

    private freeRxSlot(): number | undefined {
        const i = this.rx.findIndex((s) => s.state === "free");

        return i >= 0 ? i : undefined;
    }

    private onData(h: Header, payload: Buffer, now: number): void {
        const d = (h.seq - this.rxAckSeq) & 0xff;
        const rxWindow = this.localRxWindow();
        const already = d > 0 && d <= SACK_SPAN && ((this.rxBitmap >>> (d - 1)) & 1) === 1;

        if (d >= 256 - SACK_SPAN || already) {
            // R4 duplicate.
            this.inc("rxDuplicate");
            this.requestAck("ack");
            return;
        }

        if (d >= rxWindow) {
            // R5 outside the window.
            this.queueReject({seq: h.seq, endpoint: h.endpoint, epSeq: h.epSeq, reason: RejectReason.WINDOW_VIOLATION});
            return;
        }

        const ep = toEndpoint(h.endpoint);
        let reject: RejectReason | undefined;

        if (ep === undefined) {
            reject = RejectReason.UNKNOWN_ENDPOINT;
        } else if (payload.length > MAX_PAYLOAD) {
            reject = RejectReason.TOO_LONG;
        } else {
            const avail = (this.rxCreditEdge[ep] - h.epSeq) & 0xff;
            reject = avail >= 1 && avail <= 128 ? undefined : RejectReason.NO_CREDIT;
        }

        let slot: number | undefined;

        if (ep !== undefined) {
            slot = this.freeRxSlot();

            if (slot === undefined) {
                // Drop unrecorded so the peer retransmits.
                this.inc("rxOverflow");
                return;
            }
        }

        const holeFilled = d === 0 && this.rxBitmap !== 0;

        if (d === 0) {
            this.rxAckSeq = (this.rxAckSeq + 1) & 0xff;

            for (;;) {
                const b0 = this.rxBitmap & 1;
                this.rxBitmap >>>= 1;

                if (!b0) {
                    break;
                }

                this.rxAckSeq = (this.rxAckSeq + 1) & 0xff;
            }
        } else {
            this.rxBitmap = (this.rxBitmap | (1 << (d - 1))) >>> 0;
        }

        if (ep !== undefined && slot !== undefined) {
            const s = this.rx[slot];
            s.endpoint = ep;
            s.epSeq = h.epSeq;

            if (reject !== undefined) {
                s.state = "tombstone";
                s.payload = Buffer.alloc(0);
            } else {
                s.state = "buffered";
                s.payload = Buffer.from(payload);
                this.lastRxEpSeq[ep] = h.epSeq;
            }

            this.deliverReady(ep);
        }

        if (reject !== undefined) {
            this.queueReject({seq: h.seq, endpoint: h.endpoint, epSeq: h.epSeq, reason: reject});
        }

        if (d === 0) {
            if (holeFilled) {
                this.requestAck("ack"); // R3
            } else {
                // R1.
                this.framesSinceAck = Math.min(255, this.framesSinceAck + 1);

                if (this.delayedAckAt === undefined) {
                    this.delayedAckAt = now + this.cfg.ackDelayUs;
                }

                if (this.framesSinceAck >= Math.max(1, Math.floor(rxWindow / 2))) {
                    this.requestAck("ack");
                }
            }
        } else {
            // R2.
            this.inc("rxOutOfOrder");
            this.requestAck("nak");
        }
    }

    private deliverReady(e: number): void {
        for (;;) {
            const exp = this.expectedEpSeq[e];
            const s = this.rx.find((x) => (x.state === "buffered" || x.state === "tombstone") && x.endpoint === e && x.epSeq === exp);

            if (s === undefined) {
                return;
            }

            this.expectedEpSeq[e] = (exp + 1) & 0xff;

            if (s.state === "tombstone") {
                // A rejected frame consumed its ep_seq without holding a buffer.
                s.state = "free";
                this.rxCreditEdge[e] = (this.rxCreditEdge[e] + 1) & 0xff;
                this.creditDirty |= 1 << e;
            } else {
                s.state = "ready";
                s.order = this.readyCounter++;
            }
        }
    }

    private doReleaseCredit(e: number, frames: number): void {
        if (e <= 0 || e >= NEP || frames === 0 || this.state !== LinkState.ESTABLISHED) {
            return;
        }

        const old = this.rxCreditEdge[e];
        this.rxCreditEdge[e] = (old + frames) & 0xff;
        this.creditDirty |= 1 << e;

        if (this.lastRxEpSeq[e] === ((old - 1) & 0xff)) {
            // R8: the peer is blocked on this endpoint.
            this.requestAck("ack");
        }
    }

    // #endregion

    // #region Transmit-side acknowledgement processing

    private processAck(ack: number, sack: number | undefined, now: number): void {
        const inflight = (this.nextSeq - this.base) & 0xff;
        const adv = (ack - this.base) & 0xff;

        if (adv > inflight) {
            return; // stale or bogus
        }

        let d: number | undefined;
        let sample: number | undefined;
        const base = this.base;

        for (const s of this.tx) {
            if (s.state !== "inflight") {
                continue;
            }

            const off = (s.seq - base) & 0xff;

            if (off < adv) {
                if (!s.sacked) {
                    d = d === undefined ? s.lastTxOrder : Math.max(d, s.lastTxOrder);

                    if (s.retxCount === 0) {
                        sample = Math.max(0, now - s.firstTx);
                    }
                }

                s.state = "free";
                s.needsRetx = false;
            } else if (sack !== undefined) {
                const i = (s.seq - ack - 1) & 0xff;

                if (i < SACK_SPAN && ((sack >>> i) & 1) === 1 && !s.sacked) {
                    s.sacked = true;
                    s.needsRetx = false;
                    d = d === undefined ? s.lastTxOrder : Math.max(d, s.lastTxOrder);

                    if (s.retxCount === 0) {
                        sample = Math.max(0, now - s.firstTx);
                    }
                }
            }
        }

        this.base = ack;

        if (sample !== undefined && this.cfg.adaptiveRto) {
            this.rttSample(sample);
        }

        if (d !== undefined) {
            // S1: FIFO loss inference.
            for (const s of this.tx) {
                if (s.state === "inflight" && !s.sacked && s.lastTxOrder < d) {
                    s.needsRetx = true;
                }
            }

            if (this.dMax === undefined || d > this.dMax) {
                this.dMax = d;
                this.nbadHandled = 0;
            }

            this.blockedSince = undefined;
        }
    }

    private processNbad(k: number): void {
        // S2.
        if (k <= this.nbadHandled) {
            return;
        }

        const dMax = this.dMax;
        const lst = this.tx
            .filter((s) => s.state === "inflight" && !s.sacked && (dMax === undefined || s.lastTxOrder > dMax))
            .sort((a, b) => a.lastTxOrder - b.lastTxOrder);

        for (const s of lst.slice(this.nbadHandled, Math.min(k, lst.length))) {
            s.needsRetx = true;
        }

        this.nbadHandled = k;
    }

    private onReject(body: RejectBody, now: number): void {
        const reason = body.reason;

        if (reason === RejectReason.NO_CREDIT || reason === RejectReason.TOO_LONG || reason === RejectReason.UNKNOWN_ENDPOINT) {
            for (const s of this.tx) {
                if (s.state === "inflight" && s.seq === body.seq) {
                    s.state = "failed";
                    s.failure = TxFailure.REJECTED;
                    s.rejectReason = reason;
                    s.needsRetx = false;
                    this.inc("txRejected");
                    break;
                }
            }
        } else if (reason === RejectReason.WINDOW_VIOLATION) {
            for (const s of this.tx) {
                if (s.state === "inflight" && s.seq === body.seq) {
                    s.state = "failed";
                    s.failure = TxFailure.REJECTED;
                    s.rejectReason = reason;
                    this.inc("txRejected");
                    break;
                }
            }

            this.linkFailed(now, ResetReason.PROTOCOL_ERROR);
        }
        // STALE_EPOCH / NOT_IN_SESSION / UNSUPPORTED change no ARQ state.
    }

    private rttSample(r: number): void {
        // RFC 6298.
        if (this.srtt === undefined) {
            this.srtt = r;
            this.rttvar = Math.floor(r / 2);
        } else {
            const diff = Math.abs(this.srtt - r);
            this.rttvar = Math.floor((3 * this.rttvar + diff) / 4);
            this.srtt = Math.floor((7 * this.srtt + r) / 8);
        }

        const rto = this.srtt + 4 * this.rttvar;
        this.rto = Math.max(this.cfg.rtoMinUs, Math.min(this.cfg.rtoMaxUs, rto));
    }

    // #endregion

    // #region Timers

    private oldestUnsacked(): number | undefined {
        let best: number | undefined;

        for (let i = 0; i < this.tx.length; i++) {
            const s = this.tx[i];

            if (s.state === "inflight" && !s.sacked && (best === undefined || s.lastTxOrder < this.tx[best].lastTxOrder)) {
                best = i;
            }
        }

        return best;
    }

    private handleTimers(now: number): void {
        if (this.state === LinkState.UNSYNCED) {
            return;
        }

        if (this.state === LinkState.RESETTING) {
            if (now >= this.resetRetryAt) {
                this.resetTx = this.answered !== undefined ? "ack" : "req";
                this.anyTx = false;
                this.resetRetryMs = Math.min(this.resetRetryMs * 2, this.cfg.resetRetryMaxMs);
                this.resetRetryAt = now + this.resetRetryMs * 1000;
            }

            return;
        }

        if (now >= this.lastRxValid + this.linkTimeoutUs) {
            this.inc("linkDownEvents");
            this.pushCtl({type: "linkDown"});
            this.beginReset(now, ResetReason.PEER_TIMEOUT);
            return;
        }

        if (this.delayedAckAt !== undefined && now >= this.delayedAckAt) {
            this.requestAck("ack");
        }

        if (this.crcHoldoffUntil !== undefined && now >= this.crcHoldoffUntil) {
            this.crcHoldoffUntil = undefined;

            if (this.crcNakAfterHoldoff && this.nbad !== this.nbadReported) {
                this.ackReq = "nak";
                this.crcHoldoffUntil = now + this.cfg.ackDelayUs;
            }

            this.crcNakAfterHoldoff = false;
        }

        // S3: RTO on the oldest unacked, unsacked frame.
        const i = this.oldestUnsacked();

        if (i !== undefined) {
            const s = this.tx[i];

            if (!s.needsRetx && now >= s.lastTx + this.rto) {
                this.inc("txRtoExpiries");
                s.needsRetx = true;
                s.retxPoll = true;
                this.rto = Math.min(this.rto * 2, this.cfg.rtoMaxUs);
            }
        }

        if (now >= this.lastTx + this.keepaliveUs) {
            this.keepaliveDue = true;
        }

        // S5: blocked sender.
        const b = this.blockedSince;

        if (b !== undefined && now >= b + this.keepaliveUs) {
            const ms = Math.floor((now - b) / 1000);
            this.inc(this.blockedByWindow ? "txBlockedWindowMs" : "txBlockedCreditMs", ms);
            this.keepaliveDue = true;
            this.blockedSince = now;
        }
    }

    // #endregion

    // #region Transmit

    private leadZero(now: number): boolean {
        const lead = !this.anyTx || now >= this.lastTx + RESYNC_IDLE_US;
        this.anyTx = true;

        return lead;
    }

    private sent(now: number, n: number): void {
        this.lastTx = now;
        this.inc("txFrames");
        this.inc("txBytes", n);
    }

    private transmit(now: number, src: TxSource): Buffer | undefined {
        if (this.resetTx !== undefined) {
            const kind = this.resetTx;
            this.resetTx = undefined;

            return this.sendReset(kind, now);
        }

        if (this.state !== LinkState.ESTABLISHED) {
            return undefined;
        }

        const reject = this.rejects.shift();

        if (reject) {
            const w = encodeWire(header(FrameType.REJECT, {epoch: this.epoch, ack: this.rxAckSeq}), encodeRejectBody(reject), this.leadZero(now));
            this.sent(now, w.length);

            return w;
        }

        if (this.ackReq !== undefined) {
            return this.sendAck(this.ackReq, false, false, now);
        }

        const retx = this.sendRetransmission(now);

        if (retx !== undefined) {
            return retx;
        }

        const fresh = this.sendNew(now, src);

        if (fresh !== undefined) {
            return fresh;
        }

        if (this.keepaliveDue) {
            this.keepaliveDue = false;

            return this.sendAck("ack", true, true, now);
        }

        return undefined;
    }

    private sendReset(kind: "req" | "ack", now: number): Buffer {
        const type = kind === "req" ? FrameType.RESET_REQ : FrameType.RESET_ACK;
        const peerCookie = kind === "req" ? (this.peerKnown ?? 0) : (this.answered ?? this.peerKnown ?? 0);
        const credits = [...this.cfg.initialCredits, ...new Array(NEP).fill(0)];
        const body = resetBody({
            cookie: this.cookie,
            peerCookie,
            role: this.cfg.role,
            rxWindow: this.localRxWindow(),
            reason: this.resetReason,
            rxMtu: MAX_PAYLOAD,
            ackDelayUs: this.cfg.ackDelayUs,
            keepaliveMs: this.cfg.keepaliveMs,
            linkTimeoutMs: this.cfg.linkTimeoutMs,
            credits: DATA_ENDPOINTS.map((ep): [number, number] => [ep, credits[ep]]),
        });
        const w = encodeWire(header(type), encodeResetBody(body), this.leadZero(now));
        this.sent(now, w.length);

        return w;
    }

    private sendAck(kind: "ack" | "nak", poll: boolean, allCredits: boolean, now: number): Buffer {
        const credits: Credits = DATA_ENDPOINTS.filter((ep) => allCredits || (this.creditDirty & (1 << ep)) !== 0).map((ep) => [
            ep,
            this.rxCreditEdge[ep],
        ]);
        this.creditDirty = 0;
        const body = encodeAckBody({sack: this.rxBitmap, nbad: this.nbad, credits});
        const h = header(kind === "nak" ? FrameType.NAK : FrameType.ACK, {epoch: this.epoch, ack: this.rxAckSeq, poll});
        const w = encodeWire(h, body, this.leadZero(now));

        if (kind === "nak") {
            this.inc("naksSent");
        }

        this.nbadReported = this.nbad;
        this.framesSinceAck = 0;
        this.delayedAckAt = undefined;
        this.ackReq = undefined;
        this.sent(now, w.length);

        return w;
    }

    private sendRetransmission(now: number): Buffer | undefined {
        let idx: number | undefined;

        for (let i = 0; i < this.tx.length; i++) {
            const s = this.tx[i];

            if (s.state === "inflight" && s.needsRetx && (idx === undefined || s.lastTxOrder < this.tx[idx].lastTxOrder)) {
                idx = i;
            }
        }

        if (idx === undefined) {
            return undefined;
        }

        const s = this.tx[idx];

        if (s.retxCount >= this.cfg.nRetxMax) {
            // S4.
            this.linkFailed(now, ResetReason.RETRY_EXHAUSTED);
            const kind = this.resetTx;
            this.resetTx = undefined;

            return kind ? this.sendReset(kind, now) : undefined;
        }

        this.txOrder++;
        const lead = this.leadZero(now);
        s.needsRetx = false;
        s.retxCount++;
        s.lastTx = now;
        s.lastTxOrder = this.txOrder;
        const poll = s.retxPoll;
        s.retxPoll = false;
        const h = header(FrameType.DATA, {
            epoch: this.epoch,
            endpoint: s.endpoint,
            seq: s.seq,
            ack: this.rxAckSeq,
            epSeq: s.epSeq,
            retx: true,
            poll,
        });
        const w = encodeWire(h, s.payload, lead);
        this.inc("txRetransmissions");
        this.sent(now, w.length);

        return w;
    }

    private freeTxSlot(): number | undefined {
        const i = this.tx.findIndex((s) => s.state === "free");

        return i >= 0 ? i : undefined;
    }

    private windowOpen(): boolean {
        return ((this.nextSeq - this.base) & 0xff) < this.txWindow;
    }

    private creditOk(e: number): boolean {
        const avail = (this.txCreditEdge[e] - this.nextEpSeq[e]) & 0xff;

        return avail >= 1 && avail <= 128;
    }

    private bulkQuotaOk(): boolean {
        const used = this.tx.filter((s) => s.state === "inflight" && isBulkClass(s.endpoint)).length;

        return used < Math.max(1, Math.floor(this.txWindow / 2));
    }

    private admissible(ep: LinkEndpoint): boolean {
        return ep !== LinkEndpoint.LINK && this.windowOpen() && this.creditOk(ep) && (!isBulkClass(ep) || this.bulkQuotaOk());
    }

    private sendNew(now: number, src: TxSource): Buffer | undefined {
        if (!BY_PRIORITY.some((e) => src.ready(e))) {
            this.blockedSince = undefined;
            return undefined;
        }

        const slot = this.freeTxSlot();
        const cands = slot !== undefined ? BY_PRIORITY.filter((e) => src.ready(e) && this.admissible(e)) : [];

        if (cands.length === 0 || slot === undefined) {
            if (this.blockedSince === undefined) {
                this.blockedSince = now;
                this.blockedByWindow = !this.windowOpen() || slot === undefined;
            }

            return undefined;
        }

        let chosen = cands[0];

        if (cands.length > 1) {
            if (this.consecutiveHigh >= STARVATION_FRAMES) {
                // Anti-starvation: the longest-waiting lower-priority endpoint.
                chosen = cands.slice(1).reduce((a, b) => (this.lastServed[b] < this.lastServed[a] ? b : a));
                this.consecutiveHigh = 0;
            } else {
                this.consecutiveHigh++;
            }
        } else {
            this.consecutiveHigh = 0;
        }

        const mtu = Math.min(this.peer.rxMtu, MAX_PAYLOAD);
        const payload = src.fill(chosen, mtu);

        if (payload.length === 0 || payload.length > mtu) {
            return undefined;
        }

        this.blockedSince = undefined;
        this.servedCounter++;
        this.lastServed[chosen] = this.servedCounter;
        this.txOrder++;
        const seq = this.nextSeq;
        const epSeq = this.nextEpSeq[chosen];
        this.nextSeq = (seq + 1) & 0xff;
        this.nextEpSeq[chosen] = (epSeq + 1) & 0xff;
        const lead = this.leadZero(now);
        const s = this.tx[slot];
        s.state = "inflight";
        s.failure = undefined;
        s.rejectReason = undefined;
        s.seq = seq;
        s.endpoint = chosen;
        s.epSeq = epSeq;
        s.payload = Buffer.from(payload);
        s.sacked = false;
        s.needsRetx = false;
        s.retxPoll = false;
        s.retxCount = 0;
        s.firstTx = now;
        s.lastTx = now;
        s.lastTxOrder = this.txOrder;
        const w = encodeWire(header(FrameType.DATA, {epoch: this.epoch, endpoint: chosen, seq, ack: this.rxAckSeq, epSeq}), s.payload, lead);
        this.sent(now, w.length);

        return w;
    }

    // #endregion

    private releaseLent(): void {
        const lent = this.lent;

        if (lent === undefined) {
            return;
        }

        this.lent = undefined;
        const [kind, i] = lent;

        if (kind === "rx") {
            const s = this.rx[i];
            const e = s.endpoint;
            s.state = "free";
            s.payload = Buffer.alloc(0);

            if (this.cfg.autoCredit) {
                this.doReleaseCredit(e, 1);
            }
        } else {
            this.tx[i].state = "free";
            this.tx[i].payload = Buffer.alloc(0);
        }
    }
}

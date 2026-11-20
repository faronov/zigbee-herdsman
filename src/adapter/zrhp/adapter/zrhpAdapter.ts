/**
 * zigbee-herdsman adapter for zigbee-rs NCPs over ZRHP v1 (spec 12.3).
 *
 * The NCP runs the Zigbee stack, Trust Center and GP proxy; this adapter maps herdsman's {@link Adapter} API onto ZRHP
 * commands, keeps a small sidecar store (`zrhp_store.jsonl`) next to the database, and hides NCP reboots and transient link
 * losses (seamless resume, spec 12.1) as long as the NCP still holds the same network.
 */

import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import type {Backup} from "../../../models/backup";
import {logger} from "../../../utils/logger";
import {Queue} from "../../../utils/queue";
import {wait} from "../../../utils/wait";
import {Waitress} from "../../../utils/waitress";
import * as ZSpec from "../../../zspec";
import * as Zcl from "../../../zspec/zcl";
import * as Zdo from "../../../zspec/zdo";
import type * as ZdoTypes from "../../../zspec/zdo/definition/tstypes";
import {Adapter, type ClusterWaitressMatcher, type ZclWaitressPayload} from "../../adapter";
import type {ZclPayload} from "../../events";
import type * as TsType from "../../tstype";
import {readBackup} from "../../utils";
import {LinkResetError, type SessionInfo, SessionLost, ZrhpApi, ZrhpError} from "../api";
import {type Codec, encodeWith, type StructOf} from "../codec";
import {AddrMode, Capacity, FC_STRIDE, IndicationFlags, LOCK_CONFIRM, NcpCaps, NetworkState, Status, TxOptions, ZB_APS_NO_ACK} from "../consts";
import type {ByteStream} from "../driver";
import {PeerChange} from "../link";
import * as M from "../messages";
import {ieeeText, type Json, ocbToRecords, passthroughInternal, recordsToOcb, restoreMargins} from "../ocb";
import {
    DeviceFlags,
    type DeviceRecordValue,
    decodeRecords,
    encodeRecord,
    endRecord,
    KeyAttrs,
    KeyOrigin,
    RecordType,
    type ZrhpRecord,
} from "../records";
import {type LinkKeyRow, SidecarStore} from "../store";
import {isLocalZdo, type LocalEndpoint, localZdoResponse} from "../zdo";

const NS = "zh:zrhp";

/** Default UART rate (spec 4.1); ignored by USB-Serial-JTAG. */
export const DEFAULT_BAUDRATE = 921_600;
/** The no-flow-control fallback rate (spec 4.4, 11.5). */
export const FALLBACK_BAUDRATE = 460_800;
/** NWK frame-counter margin of a restore from a herdsman backup (herdsman adds nothing itself, spec 12.3). */
const NWK_RESTORE_MARGIN = 10_000;
/** `BKP_EXPORT_READ` chunk. */
const EXPORT_CHUNK = 600;
/** `BKP_RESTORE_PUT` payload budget (633 B message minus txn). */
const PUT_BUDGET = 600;
const APS_RETRY_DELAYS = [50, 100, 200, 400, 800, 1000, 1000, 1000];
/** Join -> authorization wait before `deviceJoined` is emitted anyway. */
const AUTHORIZE_WAIT_MS = 5000;
const GP_SINK_MODE_HOST = 0;

/** Tunables, optionally overridden by `zrhp_config.json` next to the backup file. */
export interface ZrhpConfig {
    /** how long a lost NCP may take to come back before herdsman is told (ms) */
    resumeBudgetMs: number;
    /** handshake + negotiation timeout (ms) */
    connectTimeoutMs: number;
    /** APS confirm timeout (ms); covers sleepy destinations (spec 7.3) */
    confirmTimeoutMs: number;
    /** try 460 800 baud without flow control when the configured rate gets no frame */
    baudrateFallback: boolean;
    /** DTR/RTS hard reset when the NCP stays silent (spec 11.3) */
    hardResetOnFailure: boolean;
    /** `SEC_LOCK_KEY_EXPORT` after every backup (backups then become incomplete until the NCP reboots) */
    lockKeyExport: boolean;
}

export const DEFAULT_CONFIG: Readonly<ZrhpConfig> = {
    resumeBudgetMs: 20_000,
    connectTimeoutMs: 5000,
    confirmTimeoutMs: 40_000,
    baudrateFallback: true,
    hardResetOnFailure: true,
    lockKeyExport: false,
};

/** The byte transport used by the adapter (the herdsman serial port, or a test stream). */
export interface ZrhpPort extends ByteStream {
    open(baudRate: number, rtscts: boolean): Promise<void>;
    close(): Promise<void>;
    /** Set DTR and RTS together (one `TIOCMSET`, spec 11.3). */
    setLines(dtr: boolean, rts: boolean): Promise<void>;
    onData: (data: Buffer) => void;
    onClose: (error?: Error) => void;
}

export interface ZrhpAdapterOptions {
    /** Replace the serial port (tests: the Rust NCP simulator over stdio). */
    port?: ZrhpPort;
    config?: Partial<ZrhpConfig>;
}

/** Coordinator endpoints registered with `NWK_ADD_ENDPOINT` (herdsman's EmberZNet set, ≤ 16 clusters per list). */
export const HOST_ENDPOINTS: readonly LocalEndpoint[] = [
    {
        endpoint: 1,
        profileId: ZSpec.HA_PROFILE_ID,
        deviceId: 0x65,
        deviceVersion: 1,
        inClusters: [0x0000, 0x0003, 0x0006, 0x0008, 0x000a, 0x0019, 0x0300],
        outClusters: [0x0000, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008, 0x0020, 0x0300, 0x0400, 0x0402, 0x0405, 0x0406, 0x0500, 0x0702, 0x0b03, 0x0b04],
    },
];

/** The GP endpoint is owned by the NCP (proxy); it is reported locally, never registered (12.1.1 Z8). */
const GP_LOCAL_ENDPOINT: LocalEndpoint = {
    endpoint: ZSpec.GP_ENDPOINT,
    profileId: ZSpec.GP_PROFILE_ID,
    deviceId: 0x66,
    deviceVersion: 1,
    inClusters: [Zcl.Clusters.greenPower.ID],
    outClusters: [Zcl.Clusters.greenPower.ID],
};

type ZdoResponse = {address: number | string; clusterId: number; response: ZdoTypes.GenericZdoResponse; seqNum: number};
type ZdoMatcher = {address: number | string | undefined; clusterId: number; transactionSequenceNumber?: number};
type NwkInfo = StructOf<typeof M.NwkGetInfoRsp.fields>;
type Confirm = StructOf<typeof M.EvtApsDataConfirm.fields>;

/** `NWK_GET_INFO` carries the stored network (valid in state 1 before `NWK_INIT`, Z11) rather than an unconfigured NIB. */
function storedIdentity(info: NwkInfo): boolean {
    return (
        info.panId !== 0x0000 &&
        info.panId !== 0xffff &&
        !info.extPanId.equals(Buffer.alloc(8)) &&
        !info.extPanId.equals(Buffer.alloc(8, 0xff)) &&
        !info.ieee.equals(Buffer.alloc(8))
    );
}

/** Groups of the coordinator endpoint 1 set up at every start (as ember: 0 and Z2M's default bind group 901). */
const DEFAULT_GROUPS = [0x0000, 901];
/** `EVT_CHANNEL_CHANGED` comes `nwkNetworkBroadcastDeliveryTime` (9 s) after the answer. */
const CHANNEL_CHANGE_WAIT_MS = 20_000;

/** big-endian `0x…` string of on-air bytes */
function hexBE(onAir: Buffer): string {
    return `0x${Buffer.from(onAir).reverse().toString("hex")}`;
}

/** on-air bytes of a big-endian `0x…` string */
function onAirOf(ieee: string): Buffer {
    return Buffer.from(ieee.replace(/^0x/, "").padStart(16, "0"), "hex").reverse();
}

/** The herdsman serial transport as a {@link ZrhpPort}. */
class TransportPort implements ZrhpPort {
    readonly #adapter: ZrhpAdapter;
    onData: (data: Buffer) => void = () => undefined;
    onClose: (error?: Error) => void = () => undefined;

    constructor(adapter: ZrhpAdapter) {
        this.#adapter = adapter;
        adapter.transport.on("data", (data) => this.onData(data));
        adapter.transport.on("close", (error) => this.onClose(error instanceof Error ? error : undefined));
    }

    async open(baudRate: number, rtscts: boolean): Promise<void> {
        const t = this.#adapter.transport;
        t.options.baudRate = baudRate;
        t.options.rtscts = rtscts;
        // never XON/XOFF: 0x11/0x13 occur in COBS data (spec 4.1)
        await t.open(true);
        await new Promise<void>((resolve) => {
            const sp = t.serialPortInstance;

            if (!sp) {
                resolve();
                return;
            }

            sp.flush(() => resolve());
        });
    }

    async close(): Promise<void> {
        await this.#adapter.transport.close();
    }

    write(data: Buffer): void {
        if (this.#adapter.transport.isOpen) {
            this.#adapter.transport.write(data);
        }
    }

    async setLines(dtr: boolean, rts: boolean): Promise<void> {
        await this.#adapter.transport.set({dtr, rts});
    }
}

export class ZrhpAdapter extends Adapter {
    readonly config: ZrhpConfig;
    readonly api: ZrhpApi;
    readonly port: ZrhpPort;
    store: SidecarStore | undefined;
    private info: StructOf<typeof M.SysGetInfoRsp.fields> | undefined;
    private nwk: NwkInfo | undefined;
    private baudRate: number;
    private rtscts: boolean;
    private queue: Queue;
    private readonly zclWaitress: Waitress<ZclWaitressPayload, ClusterWaitressMatcher>;
    private readonly zdoWaitress: Waitress<ZdoResponse, ZdoMatcher>;
    private readonly confirms = new Map<number, (c: Confirm) => void>();
    private readonly networkWaiters: ((ev: StructOf<typeof M.EvtNetworkState.fields>) => void)[] = [];
    private readonly pendingJoins = new Map<string, NodeJS.Timeout>();
    private started = false;
    private stopping = false;
    private resumed = true;
    private resumeWaiters: (() => void)[] = [];
    private budgetTimer: NodeJS.Timeout | undefined;
    private reopenTimer: NodeJS.Timeout | undefined;
    private resumeRun = 0;
    private permitUntil: number | undefined;
    private channelWaiter: ((ev: StructOf<typeof M.EvtChannelChanged.fields>) => void) | undefined;
    /** groups of coordinator endpoint 1 beyond {@link DEFAULT_GROUPS}, replayed after an NCP restart */
    private readonly coordinatorGroups = new Set<number>();
    /** groups herdsman sent to that the coordinator was asked to join (ember's multicast passthrough) */
    private readonly triedGroups = new Set<number>();
    private keyExportLocked = false;
    /** counters exposed for diagnostics */
    readonly stats = {ncpResumed: 0, ncpRestarts: 0};

    constructor(
        networkOptions: TsType.NetworkOptions,
        transportOptions: TsType.TransportOptions,
        backupPath: string,
        adapterOptions: TsType.AdapterOptions,
        options: ZrhpAdapterOptions = {},
    ) {
        super(networkOptions, transportOptions, backupPath, adapterOptions);

        this.hasZdoMessageOverhead = true;
        this.manufacturerID = Zcl.ManufacturerCode.CONNECTIVITY_STANDARDS_ALLIANCE;
        this.config = {...DEFAULT_CONFIG, ...this.loadConfigFile(), ...options.config};
        // The base class reports every port close as `disconnected`; ZRHP first tries to resume (USJ re-enumeration).
        this.transport.removeAllListeners("close");
        this.port = options.port ?? new TransportPort(this);
        this.port.onData = (data) => this.api.receive(data);
        this.port.onClose = (error) => this.api.portLost(error);
        this.baudRate = transportOptions.baudRate ?? DEFAULT_BAUDRATE;
        this.rtscts = transportOptions.rtscts ?? false;
        this.api = new ZrhpApi({handshakeTimeout: this.config.connectTimeoutMs});
        this.api.addEventHandler((msg, body) => this.onEvent(msg, body));
        this.api.addSessionHandler((state, info) => this.onSession(state, info));
        this.api.setRequestHandler(async (msg, body) => await this.onNcpRequest(msg, body));
        this.queue = new Queue(this.adapterOptions.concurrent || 8);
        this.zclWaitress = new Waitress(Adapter.zclWaitressValidator, Adapter.clusterWaitressTimeoutFormatter);
        this.zdoWaitress = new Waitress(
            (p, m) => m.address === p.address && m.clusterId === p.clusterId && m.transactionSequenceNumber === p.seqNum,
            (m, t) => `Timeout after ${t}ms [address=${m.address} clusterId=${m.clusterId} tsn=${m.transactionSequenceNumber}]`,
        );
    }

    private loadConfigFile(): Partial<ZrhpConfig> {
        const path = join(dirname(this.backupPath), "zrhp_config.json");

        try {
            if (existsSync(path)) {
                const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ZrhpConfig>;
                logger.info(`Using ZRHP config overrides ${JSON.stringify(parsed)}`, NS);

                return parsed;
            }
        } catch (error) {
            logger.error(`Invalid ${path}: ${(error as Error).message}`, NS);
        }

        return {};
    }

    private get session(): SessionInfo {
        if (!this.api.session) {
            throw new SessionLost("no ZRHP session");
        }

        return this.api.session;
    }

    // #region Start / stop

    public async start(): Promise<TsType.StartResult> {
        if (this.transport.options.path && /^(tcp|socket|mdns):\/\//.test(this.transport.options.path)) {
            throw new Error("ZRHP has no network transport (spec 4): connect the NCP over USB-Serial-JTAG or UART");
        }

        this.stopping = false;
        await this.connect();
        this.store = new SidecarStore(join(dirname(this.backupPath), "zrhp_store.jsonl"));
        this.store.open();
        this.store.setMeta({lastNcpCookie: this.session.ncpCookie});

        const result = await this.initNetwork();

        await this.configureNetwork();
        this.started = true;
        const inflight = this.session.capacity(Capacity.MAX_APS_INFLIGHT, 8);
        const concurrent = Math.max(1, Math.min(this.adapterOptions.concurrent || inflight, inflight || 8));
        this.queue = new Queue(concurrent);
        logger.info(
            `Started ${result}: ${this.info?.product.toString() || "ZRHP NCP"} fw ${this.session.fwVersion}, ` +
                `${this.info?.transport === 1 ? "USB-Serial-JTAG" : `UART ${this.info?.uartBaud} baud`}, ${concurrent} APS in flight`,
            NS,
        );

        return result;
    }

    /** Open the port and complete handshake + negotiation (with the 460 800 fallback and one hard reset). */
    private async connect(): Promise<void> {
        const attempts: [number, boolean][] = [[this.baudRate, this.rtscts]];

        if (this.config.baudrateFallback && (this.baudRate !== FALLBACK_BAUDRATE || this.rtscts)) {
            attempts.push([FALLBACK_BAUDRATE, false]);
        }

        let lastError: Error | undefined;

        for (const [i, [baud, rtscts]] of attempts.entries()) {
            await this.port.open(baud, rtscts);

            try {
                await this.api.connect(this.port);
                this.baudRate = baud;
                this.rtscts = rtscts;
                lastError = undefined;
                break;
            } catch (error) {
                lastError = error as Error;
            }

            const sawFrames = this.api.handshakeRxFrames > 0;

            if (i === 0 && !sawFrames && this.config.hardResetOnFailure) {
                // A silent NCP (e.g. left in the ROM bootloader) gets one DTR/RTS reset on the configured rate.
                logger.warning(`No ZRHP session (${lastError.message}); trying a DTR/RTS hard reset`, NS);

                try {
                    await this.hardReset();
                    // native USB re-enumerates after a reset: reopen the port
                    await this.port.close().catch(() => undefined);
                    await this.port.open(baud, rtscts);
                    await this.api.connect(this.port);
                    lastError = undefined;
                    break;
                } catch (error) {
                    lastError = error as Error;
                }
            }

            this.api.disconnect();
            await this.port.close();

            if (this.api.handshakeRxFrames > 0) {
                break; // the rate is right, the NCP did not complete the handshake
            }
        }

        if (lastError) {
            throw new Error(`No ZRHP session with the NCP on ${this.transport.options.path}: ${lastError.message}`);
        }

        [, this.info] = await this.api.request(M.Id.SYS_GET_INFO, M.SysGetInfoReq, {}, M.SysGetInfoRsp);
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        this.started = false;
        clearTimeout(this.budgetTimer);
        clearTimeout(this.reopenTimer);

        for (const t of this.pendingJoins.values()) {
            clearTimeout(t);
        }

        this.pendingJoins.clear();
        this.queue.clear();
        this.zclWaitress.clear();
        this.zdoWaitress.clear();
        this.api.disconnect();
        await this.port.close();
        this.store?.close();
    }

    // #endregion

    // #region Network

    private async getInfo(): Promise<NwkInfo> {
        const [, info] = await this.api.request(M.Id.NWK_GET_INFO, M.NwkGetInfoReq, {}, M.NwkGetInfoRsp);
        this.nwk = info as NwkInfo;

        return this.nwk;
    }

    /** `NWK_INIT` with the checkpoint-log floors, then wait for the network to come up. */
    private async bringUp(): Promise<void> {
        const stride = this.session.capacity(Capacity.FC_STRIDE, FC_STRIDE) || FC_STRIDE;
        const [nwkFcFloor, apsFcFloor] = this.store?.floors(stride) ?? [0, 0];
        const up = this.waitNetworkState(20_000);
        const [status] = await this.api.request(M.Id.NWK_INIT, M.NwkInitReq, {nwkFcFloor, apsFcFloor}, M.NwkInitRsp, {
            allow: [Status.SUCCESS, Status.NOT_FORMED],
        });

        if (status === Status.NOT_FORMED) {
            up.cancel();
            throw new Error("NCP has no network");
        }

        const ev = await up.promise;

        if (ev.state !== 2) {
            throw new Error(`Network did not come up: reason ${ev.reason}, zb_status 0x${ev.zbStatus.toString(16)}`);
        }
    }

    private waitNetworkState(timeoutMs: number): {promise: Promise<StructOf<typeof M.EvtNetworkState.fields>>; cancel: () => void} {
        let cancel: () => void = () => undefined;
        const promise = new Promise<StructOf<typeof M.EvtNetworkState.fields>>((resolve, reject) => {
            const timer = setTimeout(() => {
                done();
                reject(new Error("timed out waiting for EVT_NETWORK_STATE"));
            }, timeoutMs);
            const waiter = (ev: StructOf<typeof M.EvtNetworkState.fields>): void => {
                if (ev.state === 1) {
                    return; // forming: keep waiting
                }

                done();
                resolve(ev);
            };
            const done = (): void => {
                clearTimeout(timer);
                const i = this.networkWaiters.indexOf(waiter);

                if (i >= 0) {
                    this.networkWaiters.splice(i, 1);
                }
            };
            cancel = done;
            this.networkWaiters.push(waiter);
        });

        return {promise, cancel};
    }

    /** The configured EPID as on-air bytes. herdsman stores `extendedPanID` in the order of the OCB hex string (big-endian). */
    private configEpidOnAir(): Buffer {
        return Buffer.from(this.networkOptions.extendedPanID ?? []).reverse();
    }

    private async ncpNetworkKey(): Promise<Buffer | undefined> {
        try {
            const [, rsp] = await this.api.request(M.Id.SEC_GET_NETWORK_KEY, M.SecGetNetworkKeyReq, {which: 0}, M.SecGetNetworkKeyRsp);

            return rsp?.key;
        } catch (error) {
            logger.warning(`Cannot read the network key from the NCP (${(error as Error).message}); comparing PAN/EPID only`, NS);
            return undefined;
        }
    }

    private configMatches(panId: number, epidOnAir: Buffer, key: Buffer | undefined): boolean {
        return (
            panId === this.networkOptions.panID &&
            epidOnAir.equals(this.configEpidOnAir()) &&
            (key === undefined || this.networkOptions.networkKey === undefined || key.equals(Buffer.from(this.networkOptions.networkKey)))
        );
    }

    /** The herdsman backup file as raw OCB JSON (only `zigpy/open-coordinator-backup` v1 is accepted). */
    private storedBackup(): Json | undefined {
        const data = readBackup(this.backupPath) as Json;

        if (data === undefined) {
            return undefined;
        }

        if (data?.metadata?.format !== "zigpy/open-coordinator-backup" || data.metadata.version !== 1) {
            logger.warning("Ignoring coordinator backup: not an open coordinator backup v1", NS);
            return undefined;
        }

        return data;
    }

    private backupMatchesConfig(b: Json): boolean {
        return (
            Number.parseInt(String(b.pan_id).padStart(4, "0"), 16) === this.networkOptions.panID &&
            String(b.extended_pan_id).toLowerCase() === Buffer.from(this.networkOptions.extendedPanID ?? []).toString("hex") &&
            this.networkOptions.channelList.includes(b.channel) &&
            (this.networkOptions.networkKey === undefined ||
                String(b.network_key?.key).toLowerCase() === Buffer.from(this.networkOptions.networkKey).toString("hex"))
        );
    }

    /** The start-result rules of spec 12.3. */
    private async initNetwork(): Promise<TsType.StartResult> {
        let info = await this.getInfo();

        if (info.state === NetworkState.FORMED_DOWN && !storedIdentity(info)) {
            // NCP images before the Z11 fix report an unconfigured NIB until NWK_INIT: bring it up before comparing
            await this.bringUp();
            info = await this.getInfo();
        }

        const backup = this.storedBackup();

        if (info.state !== NetworkState.NONE) {
            const key = await this.ncpNetworkKey();

            if (this.configMatches(info.panId, info.extPanId, key)) {
                logger.info("NCP network matches the configuration", NS);

                if (info.state !== NetworkState.UP) {
                    await this.bringUp();
                    await this.getInfo();
                }

                return "resumed";
            }

            const backupMatchesNcp =
                backup !== undefined &&
                Number.parseInt(String(backup.pan_id).padStart(4, "0"), 16) === info.panId &&
                String(backup.extended_pan_id).toLowerCase() === hexBE(info.extPanId).slice(2);

            if (backupMatchesNcp) {
                logger.error("Configuration is not consistent with the NCP network and its backup!", NS);
                logger.error(`- PAN ID: configured=${this.networkOptions.panID}, NCP=${info.panId}`, NS);
                logger.error(
                    `- Extended PAN ID: configured=${Buffer.from(this.networkOptions.extendedPanID ?? []).toString("hex")}, NCP=${hexBE(info.extPanId).slice(2)}`,
                    NS,
                );
                logger.error(`If you wish to re-commission your network, remove the coordinator backup at ${this.backupPath}.`, NS);

                if (this.adapterOptions.forceStartWithInconsistentAdapterConfiguration) {
                    logger.error("Running despite the configuration mismatch as configured.", NS);

                    if (info.state !== NetworkState.UP) {
                        await this.bringUp();
                        await this.getInfo();
                    }

                    return "resumed";
                }

                throw new Error("startup failed - configuration-adapter mismatch - see logs above for more information");
            }

            if (backup !== undefined && this.backupMatchesConfig(backup)) {
                // 9.4 rule 1: BEGIN with the network up, COMMIT replaces it (older NCPs: wipe first)
                logger.info("NCP network does not match the configuration: restoring the backup over it", NS);
                await this.restoreFromOcb(backup, true);
                await this.bringUp();
                await this.getInfo();

                return "restored";
            }

            logger.info("NCP network does not match the configuration: leaving it", NS);
            await this.leaveReset(0x02);
        }

        if (backup !== undefined && this.backupMatchesConfig(backup)) {
            await this.restoreFromOcb(backup, false);
            await this.bringUp();
            await this.getInfo();

            return "restored";
        }

        if (backup !== undefined) {
            logger.info("Configuration does not match the coordinator backup: forming a new network", NS);
        }

        await this.formFromConfig();

        return "reset";
    }

    private async leaveReset(flags: number): Promise<void> {
        await this.api.request(M.Id.NWK_LEAVE_RESET, M.NwkLeaveResetReq, {flags}, undefined, {timeout: 15_000});
        this.store?.clearNetwork();
    }

    private async formFromConfig(): Promise<void> {
        const channel = this.networkOptions.channelList[0];
        const key = this.networkOptions.networkKey ? Buffer.from(this.networkOptions.networkKey) : Buffer.alloc(16);
        this.store?.clearNetwork();
        const up = this.waitNetworkState(60_000);

        try {
            await this.api.request(
                M.Id.NWK_FORM,
                M.NwkFormReq,
                {
                    channelMask: (1 << channel) >>> 0,
                    panId: this.networkOptions.panID,
                    extPanId: this.configEpidOnAir(),
                    networkKey: key,
                    keySeq: 0,
                    nwkUpdateId: 0,
                    txPower: Math.max(-128, Math.min(127, Math.round(this.adapterOptions.transmitPower ?? 0))),
                    nwkManager: 0,
                },
                undefined,
                {timeout: 15_000},
            );
        } catch (error) {
            up.cancel();
            throw error;
        }

        const ev = await up.promise;

        if (ev.state !== 2) {
            throw new Error(`Network formation failed: reason ${ev.reason}, zb_status 0x${ev.zbStatus.toString(16)}`);
        }

        const info = await this.getInfo();
        logger.info(`Formed network: PAN 0x${info.panId.toString(16)}, channel ${info.channel}`, NS);
    }

    /** `BKP_RESTORE_*` (spec 9.4) of a herdsman/zigpy OCB file. */
    private async restoreFromOcb(ocb: Json, networkPresent: boolean): Promise<void> {
        const active = this.info?.ieeeActive ?? Buffer.alloc(8);
        const wanted = onAirOf(String(ocb.coordinator_ieee));
        let allowIeee = !wanted.equals(active);

        if (allowIeee && !this.session.hasCap(NcpCaps.IEEE_REWRITABLE)) {
            logger.warning(
                `The NCP cannot take over the backup's coordinator IEEE ${ocb.coordinator_ieee}; restoring with its own IEEE ${hexBE(active)}`,
                NS,
            );
            const internal = ocb.metadata?.internal ?? {};
            ocb = {
                ...ocb,
                coordinator_ieee: ieeeText(active),
                metadata: {...ocb.metadata, internal: {...internal, network: {...internal.network, tc_address: ieeeText(active)}}},
            };
            allowIeee = false;
        }

        if (!this.session.hasCap(NcpCaps.BACKUP_RESTORE)) {
            throw new Error("The NCP firmware cannot restore backups (no BACKUP_RESTORE capability)");
        }

        const records = ocbToRecords(ocb, allowIeee ? 0x01 : 0x00);
        const [, apsMargin] = restoreMargins(ocb);
        const nwkMargin = NWK_RESTORE_MARGIN;
        const store = this.store as SidecarStore;
        // Rule 3: the host stores every DEVICE record before COMMIT.
        store.clearNetwork();

        for (const r of records) {
            if (r.type === RecordType.DEVICE && r.value.link) {
                store.upsertKey(rowOf(r.value, 0));
            }
        }

        // Unknown stack_specific sections and internal keys are passed through on the next backup (spec 9.1).
        store.setMeta({
            ncpIeee: ocb.coordinator_ieee,
            passthrough: {stackSpecific: foreignStackSpecific(ocb.stack_specific), internal: passthroughInternal(ocb)},
        });

        const maxPerPut = this.session.capacity(Capacity.MAX_RESTORE_RECORDS_PER_PUT, 16) || 16;
        const beginReq = {flags: allowIeee ? 0x01 : 0x00, nwkMargin, apsMargin, expectedRecords: records.length};
        let [status, begin] = await this.api.request(M.Id.BKP_RESTORE_BEGIN, M.BkpRestoreBeginReq, beginReq, M.BkpRestoreBeginRsp, {
            allow: [Status.SUCCESS, Status.INVALID_STATE],
        });

        if (status === Status.INVALID_STATE && networkPresent) {
            // NCP images before 9.4 rule 1 was relaxed restore only with the stack stopped (12.1.1 Z3)
            logger.info("NCP refuses a restore while its network runs: wiping it first", NS);
            await this.api.request(M.Id.NWK_LEAVE_RESET, M.NwkLeaveResetReq, {flags: 0x02}, undefined, {timeout: 15_000});
            [status, begin] = await this.api.request(M.Id.BKP_RESTORE_BEGIN, M.BkpRestoreBeginReq, beginReq, M.BkpRestoreBeginRsp);
        } else if (status !== Status.SUCCESS) {
            throw new ZrhpError(M.Id.BKP_RESTORE_BEGIN, status);
        }
        const txn = begin?.txn ?? 0;

        try {
            const perPut = Math.min(maxPerPut, begin?.maxRecordsPerPut || maxPerPut);
            let chunk: Buffer[] = [];
            const put = async (): Promise<void> => {
                const [, rsp] = await this.api.request(
                    M.Id.BKP_RESTORE_PUT,
                    M.BkpRestorePutReq,
                    {txn, records: Buffer.concat(chunk)},
                    M.BkpRestorePutRsp,
                    {timeout: 10_000},
                );

                for (const note of rsp?.notes ?? []) {
                    logger.info(`Restore note for record ${note.index}: ${note.note}`, NS);
                }

                chunk = [];
            };

            for (const tlv of records.map(encodeRecord)) {
                if (chunk.length > 0 && (chunk.length >= perPut || chunk.reduce((n, b) => n + b.length, 0) + tlv.length > PUT_BUDGET)) {
                    await put();
                }

                chunk.push(tlv);
            }

            await put();
            const [, commit] = await this.api.request(M.Id.BKP_RESTORE_COMMIT, M.BkpRestoreCommitReq, {txn}, M.BkpRestoreCommitRsp, {
                timeout: 30_000,
            });
            logger.info(
                `Restored backup: NWK counter ${commit?.nwkFcStart}, APS counter ${commit?.apsFcStart} (margin ${apsMargin}), ` +
                    `${commit?.linkKeysOnNcp} keys, ${commit?.children} children`,
                NS,
            );
            store.addCheckpoint(1, 0, commit?.nwkFcStart ?? 0, 0);
            store.addCheckpoint(2, 0, commit?.apsFcStart ?? 0, 0);
        } catch (error) {
            await this.api.request(M.Id.BKP_RESTORE_ABORT, M.BkpRestoreAbortReq, {txn}).catch(() => undefined);
            throw error;
        }
    }

    /** Per-start NCP configuration (RAM-only settings, replayed on every resume). */
    private async configureNetwork(): Promise<void> {
        await this.tblSync();

        for (const ep of HOST_ENDPOINTS) {
            await this.optional(M.Id.NWK_ADD_ENDPOINT, M.NwkAddEndpointReq, {
                ep: ep.endpoint,
                profile: ep.profileId,
                deviceId: ep.deviceId,
                version: ep.deviceVersion,
                inClusters: ep.inClusters,
                outClusters: ep.outClusters,
            });
        }

        // v1: herdsman is the GP sink (spec 7.11, 12.3); the NCP proxy forwards to it.
        await this.optional(M.Id.GP_SINK_CONFIG, M.GpSinkConfigReq, {
            mode: GP_SINK_MODE_HOST,
            communicationMode: 2,
            group: ZSpec.GP_GROUP_ID,
            exitMode: 0x02,
            windowS: 180,
            securityLevel: 0,
            groupcastRadius: 0,
        });
        // GP Notifications groupcast to 0x0B84 reach the host only if the GP endpoint is a member.
        await this.groupMembership(1, ZSpec.GP_GROUP_ID, ZSpec.GP_ENDPOINT);

        for (const group of new Set([...DEFAULT_GROUPS, ...this.coordinatorGroups])) {
            await this.groupMembership(1, group, HOST_ENDPOINTS[0].endpoint);
        }

        if (this.adapterOptions.transmitPower !== undefined) {
            await this.optional(M.Id.NWK_SET_TX_POWER, M.NwkSetTxPowerReq, {dbm: Math.round(this.adapterOptions.transmitPower)});
        }

        if (this.keyExportLocked) {
            await this.optional(M.Id.SEC_LOCK_KEY_EXPORT, M.SecLockKeyExportReq, {confirm: LOCK_CONFIRM});
        }

        if (!this.nwk || this.nwk.state !== NetworkState.UP) {
            await this.getInfo();
        }
    }

    private async tblSync(): Promise<void> {
        const store = this.store;

        if (!store) {
            return;
        }

        const rsp = await this.optional(
            M.Id.TBL_SYNC,
            M.TblSyncReq,
            {
                hostDbEpoch: store.meta.hostDbEpoch ?? 0,
                lastNcpTableEpoch: store.meta.tableEpoch ?? 0,
                hostMaxRev: store.meta.hostMaxRev ?? 0,
                flags: 0,
            },
            M.TblSyncRsp,
        );

        if (rsp) {
            store.setMeta({tableEpoch: rsp.ncpTableEpoch});
        }
    }

    /** A request the NCP may not implement yet (`UNSUPPORTED_COMMAND` is logged, not fatal); `true` when no response codec. */
    private async optional<T, R = true>(msgId: M.Id, codec: Codec<T>, value: T, rsp?: Codec<R>): Promise<R | undefined> {
        try {
            const [, body] = await this.api.request(msgId, codec, value, rsp);

            return body ?? (true as R);
        } catch (error) {
            if (error instanceof ZrhpError && (error.status === Status.UNSUPPORTED_COMMAND || error.status === Status.INVALID_STATE)) {
                logger.debug(`NCP does not support ${M.nameOf(msgId)} now (${Status[error.status]})`, NS);
                return undefined;
            }

            throw error;
        }
    }

    // #endregion

    // #region Seamless resume (spec 12.1)

    private onSession(state: "lost" | "ready" | "portLost", info: SessionInfo | undefined): void {
        if (!this.started || this.stopping) {
            return;
        }

        if (state === "lost" || state === "portLost") {
            if (this.resumed) {
                logger.warning(`NCP session lost; holding requests (budget ${this.config.resumeBudgetMs} ms)`, NS);
                this.resumed = false;
                this.startBudget();
            }

            if (state === "portLost") {
                this.scheduleReopen();
            }
        } else if (info) {
            const run = ++this.resumeRun;
            this.resume(info, run).catch((error) => {
                if (run === this.resumeRun) {
                    this.giveUp(error as Error);
                }
            });
        }
    }

    private scheduleReopen(): void {
        clearTimeout(this.reopenTimer);
        this.reopenTimer = setTimeout(() => {
            this.reopenTimer = undefined;

            if (this.stopping || this.api.isReady) {
                return;
            }

            this.port
                .open(this.baudRate, this.rtscts)
                .then(() => this.api.reopened(this.port))
                .catch((error) => {
                    logger.debug(`Port not back yet: ${(error as Error).message}`, NS);
                    this.scheduleReopen();
                });
        }, 1000);
    }

    private startBudget(): void {
        clearTimeout(this.budgetTimer);
        let hardResetDone = false;
        const onTimeout = (): void => {
            if (this.resumed || this.stopping) {
                return;
            }

            if (!hardResetDone && this.config.hardResetOnFailure) {
                hardResetDone = true;
                logger.warning(`NCP did not come back within ${this.config.resumeBudgetMs} ms, trying a DTR/RTS hard reset`, NS);
                this.hardReset().catch((error) => logger.debug(`Hard reset failed: ${(error as Error).message}`, NS));
                this.budgetTimer = setTimeout(onTimeout, this.config.resumeBudgetMs);
                return;
            }

            this.giveUp(new SessionLost("NCP did not resume within the budget"));
        };
        this.budgetTimer = setTimeout(onTimeout, this.config.resumeBudgetMs);
    }

    private giveUp(error: Error): void {
        if (!this.started) {
            return;
        }

        logger.error(`Cannot resume the NCP session: ${error.message}`, NS);
        this.started = false;
        clearTimeout(this.budgetTimer);
        this.releaseResumeWaiters();
        this.emit("disconnected");
    }

    private releaseResumeWaiters(): void {
        for (const w of this.resumeWaiters.splice(0)) {
            w();
        }
    }

    private async resume(info: SessionInfo, run: number): Promise<void> {
        if (info.change === PeerChange.RESTARTED) {
            this.stats.ncpRestarts++;
            await this.reconcile(info);
        } else {
            const nwk = await this.getInfo();

            if (nwk.state !== NetworkState.UP) {
                await this.reconcile(info);
            }
        }

        if (run !== this.resumeRun) {
            return;
        }

        this.stats.ncpResumed++;
        logger.info(`NCP session resumed (${info.change})`, NS);
        clearTimeout(this.budgetTimer);
        this.resumed = true;
        this.releaseResumeWaiters();
    }

    private async reconcile(info: SessionInfo): Promise<void> {
        const ready = info.ready;

        if (ready.networkState === NetworkState.NONE) {
            throw new Error("the NCP lost its network");
        }

        const epoch = this.store?.meta.tableEpoch;

        if (epoch !== undefined && epoch !== 0 && ready.tableEpoch !== epoch) {
            throw new Error(`NCP table epoch changed (${epoch} -> ${ready.tableEpoch})`);
        }

        const known = this.nwk;
        let net = await this.getInfo();

        if (net.state !== NetworkState.UP && !storedIdentity(net)) {
            // older NCP images: the identity is readable only once the network is up
            await this.bringUp();
            net = await this.getInfo();
        }

        if (known) {
            const seqGe = (a: number, b: number): boolean => ((a - b) & 0xff) < 0x80;
            const mismatch = [
                ["ieee", net.ieee.equals(known.ieee)],
                ["pan_id", net.panId === known.panId],
                ["epid", net.extPanId.equals(known.extPanId)],
                ["security_level", net.securityLevel === known.securityLevel],
                ["nwk_update_id", seqGe(net.nwkUpdateId, known.nwkUpdateId)],
                ["key_seq", seqGe(net.keySeq, known.keySeq)],
            ]
                .filter(([, ok]) => !ok)
                .map(([name]) => name);

            if (mismatch.length > 0) {
                throw new Error(`NCP network differs after restart: ${mismatch.join(", ")}`);
            }
        }

        if (net.state !== NetworkState.UP) {
            await this.bringUp();
            await this.getInfo();
        }

        [, this.info] = await this.api.request(M.Id.SYS_GET_INFO, M.SysGetInfoReq, {}, M.SysGetInfoRsp);
        await this.configureNetwork();

        const remaining = this.permitUntil === undefined ? 0 : Math.floor((this.permitUntil - Date.now()) / 1000);

        if (remaining > 0) {
            await this.optional(M.Id.NWK_PERMIT_JOIN, M.NwkPermitJoinReq, {durationS: Math.min(254, remaining), target: 0xfffc, flags: 1});
        }
    }

    /** Requests wait here while the NCP is being resumed (bounded by the resume budget). */
    private async whenResumed(): Promise<void> {
        if (this.resumed) {
            return;
        }

        await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));

        if (!this.resumed) {
            throw new Error("NCP is not available");
        }
    }

    private async hardReset(): Promise<void> {
        // (0,0) -> (RTS=1, DTR=0) for >= 10 ms -> (0,0); never leave RTS=1/DTR=0 (spec 11.3)
        await this.port.setLines(false, false);
        await this.port.setLines(false, true);
        await wait(20);
        await this.port.setLines(false, false);
        await wait(50);
        await this.port.setLines(true, true);
        await wait(1500); // NCP boot (and USJ re-enumeration on native USB)
    }

    // #endregion

    // #region Adapter API

    public async getCoordinatorIEEE(): Promise<string> {
        const ieee = this.nwk?.ieee ?? this.info?.ieeeActive ?? (await this.getInfo()).ieee;

        return hexBE(ieee);
    }

    public async getCoordinatorVersion(): Promise<TsType.CoordinatorVersion> {
        const s = this.session;

        return await Promise.resolve({
            type: "zigbee-rs ZRHP",
            meta: {
                major: s.negotiate.major,
                minor: s.negotiate.minor,
                revision: s.fwVersion,
                build: s.negotiate.buildId.toString("hex"),
                chip: s.negotiate.chip,
                product: this.info?.product.toString() ?? "",
                transport: this.info?.transport === 1 ? "usb-serial-jtag" : "uart",
            },
        });
    }

    public async reset(type: "soft" | "hard"): Promise<void> {
        if (type === "hard") {
            await this.hardReset();
            return;
        }

        await this.api.request(M.Id.SYS_RESET, M.SysResetReq, {mode: 0, confirm: 0});
    }

    public async supportsBackup(): Promise<boolean> {
        const s = this.api.session;

        return await Promise.resolve(!!(s?.hasCap(NcpCaps.BACKUP_RESTORE) && s.hasCap(NcpCaps.KEY_EXPORT) && !this.keyExportLocked));
    }

    public async backup(ieeeAddressesInDatabase: string[]): Promise<Backup> {
        await this.whenResumed();
        const records = await this.exportRecords();
        const keep = new Set(ieeeAddressesInDatabase.map((a) => a.toLowerCase().replace(/^0x/, "")));
        const passthrough = this.store?.meta.passthrough ?? {};
        const ocb = recordsToOcb(this.mergeHostKeys(records), {
            source: "zigbee-herdsman-zrhp",
            creationTime: new Date().toISOString(),
            passthroughStackSpecific: passthrough.stackSpecific ?? {},
            passthroughInternal: passthrough.internal ?? {},
        });
        ocb.devices = ocb.devices.filter((d: Json) => keep.has(d.ieee_address));
        ocb.metadata.internal.zigbee_rs = {
            fw: this.session.fwVersion,
            chip: this.session.negotiate.chip,
            build_id: this.session.negotiate.buildId.toString("hex"),
        };

        if (this.config.lockKeyExport) {
            await this.optional(M.Id.SEC_LOCK_KEY_EXPORT, M.SecLockKeyExportReq, {confirm: LOCK_CONFIRM});
            this.keyExportLocked = true;
        }

        return ocbToHerdsmanBackup(ocb);
    }

    private async exportRecords(): Promise<ZrhpRecord[]> {
        const [, begin] = await this.api.request(M.Id.BKP_EXPORT_BEGIN, M.BkpExportBeginReq, {flags: 0x07}, M.BkpExportBeginRsp);
        const txn = begin?.txn ?? 0;
        const chunks: Buffer[] = [];

        try {
            for (;;) {
                const [, rsp] = await this.api.request(M.Id.BKP_EXPORT_READ, M.BkpExportReadReq, {txn, maxBytes: EXPORT_CHUNK}, M.BkpExportReadRsp, {
                    timeout: 10_000,
                });

                chunks.push(rsp?.records ?? Buffer.alloc(0));

                if (!rsp?.more) {
                    break;
                }
            }
        } finally {
            await this.api.request(M.Id.BKP_EXPORT_END, M.BkpExportEndReq, {txn}).catch(() => undefined);
        }

        return decodeRecords(Buffer.concat(chunks));
    }

    /** Fill keys the NCP does not cache (paging) from the host store (spec 9.5, 12.1.1 Z4). */
    /**
     * 9.5 presence rule (Z4): a standalone NCP is authoritative for what it exports. An exported `DEVICE` record with a link
     * block replaces the host's key (and updates the sidecar store); one without keeps the host's key. Every link-key
     * `tx_counter` becomes the exported APS limit.
     */
    private mergeHostKeys(records: ZrhpRecord[]): ZrhpRecord[] {
        const host = new Map([...(this.store?.keys.values() ?? [])].filter((r) => r.key).map((r) => [r.ieee, r]));
        const body = records.filter((r) => r.type !== RecordType.END);
        const tclk = body.find((r) => r.type === RecordType.TC_LINK_KEY);
        const apsLimit = tclk?.type === RecordType.TC_LINK_KEY ? tclk.value.txCounter : 0;
        const seen = new Set<string>();
        let changed = false;
        const out: ZrhpRecord[] = body.map((r) => {
            if (r.type !== RecordType.DEVICE) {
                return r;
            }

            const ieee = r.value.ieee.toString("hex");
            seen.add(ieee);
            const h = host.get(ieee);

            if (r.value.link) {
                const row = rowOf(r.value, 0);

                if (this.store && (!h || h.key !== row.key || h.keySeq !== row.keySeq || h.attrs !== row.attrs)) {
                    this.store.upsertKey({...row, rev: h?.rev ?? 0});
                }

                if (apsLimit > 0 && r.value.link.txCounter !== apsLimit) {
                    changed = true;
                    return {type: RecordType.DEVICE, value: {...r.value, link: {...r.value.link, txCounter: apsLimit}}};
                }

                return r;
            }

            if (!h) {
                return r;
            }

            changed = true;
            return {type: RecordType.DEVICE, value: {...r.value, link: linkOf(h, apsLimit)}};
        });

        for (const [ieee, h] of host) {
            if (!seen.has(ieee)) {
                changed = true;
                out.push({
                    type: RecordType.DEVICE,
                    value: {
                        ieee: Buffer.from(ieee, "hex"),
                        nwk: h.nwk ?? 0xffff,
                        flags: h.nwk !== undefined ? DeviceFlags.NWK_VALID : 0,
                        link: linkOf(h, apsLimit),
                    },
                });
            }
        }

        return changed ? [...out, endRecord(out.map(encodeRecord))] : records;
    }

    public async getNetworkParameters(): Promise<TsType.NetworkParameters> {
        await this.whenResumed();
        const info = await this.getInfo();

        return {panID: info.panId, extendedPanID: hexBE(info.extPanId), channel: info.channel, nwkUpdateID: info.nwkUpdateId};
    }

    public async addInstallCode(ieeeAddress: string, key: Buffer, hashed: boolean): Promise<void> {
        const ieee = onAirOf(ieeeAddress);
        let linkKey = hashed ? key : undefined;

        if (!hashed) {
            const rsp = await this.optional(M.Id.SEC_ADD_INSTALL_CODE, M.SecAddInstallCodeReq, {ieee, code: key}, M.SecAddInstallCodeRsp);

            if (rsp) {
                return;
            }

            linkKey = ZSpec.Utils.aes128MmoHash(key);
        }

        const added = await this.optional(M.Id.SEC_ADD_LINK_KEY, M.SecAddLinkKeyReq, {
            ieee,
            key: linkKey as Buffer,
            keyType: 1,
            attrs: KeyAttrs.PROVISIONAL,
            rxFloor: 0,
            flags: 0x01,
        });

        if (added) {
            return;
        }

        // Older NCPs: unique TCLK provisioning through the TC-device table (spec 8.5 TBL_PUSH, pinned).
        const [, rsp] = await this.api.request(
            M.Id.TBL_PUSH,
            M.TblPushReq,
            {
                table: RecordType.DEVICE,
                flags: 0x01,
                records: [
                    {
                        type: RecordType.DEVICE,
                        value: {
                            ieee,
                            nwk: 0xffff,
                            flags: 0,
                            link: {
                                key: linkKey as Buffer,
                                keySeq: 0,
                                attrs: KeyAttrs.PROVISIONAL,
                                origin: hashed ? KeyOrigin.IMPORTED : KeyOrigin.INSTALL_CODE,
                                txCounter: 0,
                                rxFloor: 0,
                            },
                        },
                    },
                ],
            },
            M.TblPushRsp,
        );
        const status = rsp?.results[0]?.status ?? Status.FAILURE;

        if (status !== Status.SUCCESS) {
            throw new Error(`Install code for ${ieeeAddress} refused by the NCP: ${Status[status] ?? status}`);
        }
    }

    public waitFor(
        networkAddress: number,
        endpoint: number,
        frameType: Zcl.FrameType,
        _direction: Zcl.Direction,
        transactionSequenceNumber: number | undefined,
        clusterId: number,
        commandId: number,
        defaultRspCommandId: number | undefined,
        timeout: number,
    ): {promise: Promise<ZclPayload>; cancel: () => void} {
        const waiter = this.zclWaitress.waitFor(
            {address: networkAddress, endpoint, frameType, clusterId, commandId, defaultRspCommandId, transactionSequenceNumber},
            timeout,
        );

        return {cancel: () => this.zclWaitress.remove(waiter.ID), promise: waiter.start().promise};
    }

    // #endregion

    // #region Data path

    /** `APS_DATA_REQUEST` and its `EVT_APS_DATA_CONFIRM` (two-phase, spec 6.2). */
    private async sendAps(req: M.ApsDataRequestValue, confirmTimeoutMs = this.config.confirmTimeoutMs): Promise<Confirm> {
        await this.whenResumed();
        const payload = encodeWith(M.ApsDataRequest, req);

        for (const delay of [...APS_RETRY_DELAYS, undefined]) {
            let tid: number | undefined;
            let resolveConfirm: (c: Confirm) => void = () => undefined;
            const confirm = new Promise<Confirm>((resolve) => {
                resolveConfirm = resolve;
            });
            let raw: Buffer;

            try {
                raw = await this.api.requestRaw(M.Id.APS_DATA_REQUEST, payload, {
                    retry: true,
                    busyRetry: false, // the loop below retries BUSY with its own confirm bookkeeping
                    onSent: (t) => {
                        tid = t;
                        this.confirms.set(t, resolveConfirm);
                    },
                });
            } catch (error) {
                if (tid !== undefined) {
                    this.confirms.delete(tid);
                }

                if (error instanceof LinkResetError) {
                    throw new Error("NCP restarted, delivery unknown");
                }

                throw new Error(`APS request failed: ${(error as Error).message}`);
            }

            const status = raw[0];

            if (status === Status.BUSY && delay !== undefined) {
                this.confirms.delete(tid as number);
                await wait(delay);
                continue;
            }

            if (status !== Status.SUCCESS) {
                this.confirms.delete(tid as number);
                throw new Error(`NCP refused the APS request: ${Status[status] ?? status}`);
            }

            let timer: NodeJS.Timeout | undefined;

            try {
                const ev = await Promise.race([
                    confirm,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error(`No APS confirm from the NCP (zb_status 0x${ZB_APS_NO_ACK.toString(16)})`)),
                            confirmTimeoutMs,
                        );
                    }),
                ]);

                if (ev.status !== 0) {
                    throw new Error(`Delivery failed: zb_status 0x${ev.zbStatus.toString(16)}`);
                }

                return ev;
            } finally {
                clearTimeout(timer);
                this.confirms.delete(tid as number);
            }
        }

        throw new Error("NCP APS queue stayed busy");
    }

    public async sendZdo(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: Zdo.ClusterId,
        payload: Buffer,
        disableResponse: true,
    ): Promise<void>;
    public async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: K,
        payload: Buffer,
        disableResponse: false,
    ): Promise<ZdoTypes.RequestToResponseMap[K]>;
    public async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: K,
        payload: Buffer,
        disableResponse: boolean,
    ): Promise<ZdoTypes.RequestToResponseMap[K] | undefined> {
        const coordinatorIeee = await this.getCoordinatorIEEE();

        if (clusterId === Zdo.ClusterId.NWK_UPDATE_REQUEST && payload[5] === 0xfe) {
            // channel change (scan duration 0xFE): the NCP broadcasts it and switches itself (spec 7.4)
            await this.changeChannel(payload);
            return undefined;
        }

        if (clusterId === Zdo.ClusterId.PERMIT_JOINING_REQUEST && (networkAddress === 0x0000 || networkAddress === 0xfffc)) {
            await this.api.request(M.Id.NWK_PERMIT_JOIN, M.NwkPermitJoinReq, {durationS: payload[1], target: networkAddress, flags: 0x01});
            this.notePermit(payload[1]);

            return disableResponse ? undefined : ([Zdo.Status.SUCCESS, undefined] as ZdoTypes.RequestToResponseMap[K]);
        }

        if (isLocalZdo(networkAddress, networkAddress === 0x0000 ? undefined : ieeeAddress, coordinatorIeee)) {
            const rsp = await localZdoResponse(this.localZdoContext(), clusterId, payload);

            if (rsp === undefined) {
                return undefined;
            }

            const respClusterId = clusterId | 0x8000;
            const result = Zdo.Buffalo.readResponse(this.hasZdoMessageOverhead, respClusterId, rsp) as ZdoTypes.RequestToResponseMap[K];
            this.emit("zdoResponse", respClusterId, result);

            return result;
        }

        return await this.queue.execute(async () => {
            const broadcast = networkAddress >= 0xfff8;
            const responseClusterId = disableResponse ? undefined : Zdo.Utils.getResponseClusterId(clusterId);
            const waiter =
                responseClusterId !== undefined
                    ? this.zdoWaitress.waitFor(
                          {
                              address: responseClusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE ? ieeeAddress : networkAddress,
                              clusterId: responseClusterId,
                              transactionSequenceNumber: payload[0],
                          },
                          15_000,
                      )
                    : undefined;

            try {
                await this.sendAps(
                    M.apsDataRequest({
                        dstMode: broadcast ? AddrMode.BROADCAST : AddrMode.NWK,
                        dst: networkAddress,
                        dstEp: 0,
                        srcEp: 0,
                        profile: Zdo.ZDO_PROFILE_ID,
                        cluster: clusterId,
                        txOptions: broadcast ? 0 : TxOptions.APS_ACK,
                        asdu: payload,
                    }),
                );
            } catch (error) {
                if (waiter) {
                    this.zdoWaitress.remove(waiter.ID);
                }

                throw error;
            }

            if (waiter) {
                const resp = await waiter.start().promise;

                return resp.response as ZdoTypes.RequestToResponseMap[K];
            }

            return undefined;
        }, networkAddress);
    }

    private async changeChannel(payload: Buffer): Promise<void> {
        const mask = payload.readUInt32LE(1);
        const channel = Math.log2(mask);
        const nwkUpdateId = payload[6] ?? 0;

        if (!Number.isInteger(channel)) {
            throw new Error(`Invalid channel mask 0x${mask.toString(16)}`);
        }

        // EVT_CHANNEL_CHANGED names the request by its TID (BUSY retries send new ones)
        const tids = new Set<number>();
        let settle: ((ev: StructOf<typeof M.EvtChannelChanged.fields>) => void) | undefined;
        const changed = new Promise<StructOf<typeof M.EvtChannelChanged.fields> | undefined>((resolve) => {
            const timer = setTimeout(() => {
                settle = undefined;
                resolve(undefined);
            }, CHANNEL_CHANGE_WAIT_MS);
            settle = (ev) => {
                if (tids.has(ev.reqTid)) {
                    clearTimeout(timer);
                    settle = undefined;
                    resolve(ev);
                }
            };
        });
        this.channelWaiter = (ev) => settle?.(ev);

        try {
            await this.api.request(M.Id.NWK_CHANGE_CHANNEL, M.NwkChangeChannelReq, {channel, nwkUpdateId}, undefined, {
                onSent: (tid) => tids.add(tid),
            });
        } catch (error) {
            this.channelWaiter = undefined;

            if (error instanceof ZrhpError && error.status === Status.UNSUPPORTED_COMMAND) {
                throw new Error(
                    `This NCP firmware cannot change the channel yet (NWK_CHANGE_CHANNEL). Set the configured channel back to ${this.nwk?.channel}.`,
                );
            }

            throw error;
        }

        logger.info(`NCP announced the move to channel ${channel}; waiting for the switch`, NS);
        const ev = await changed;
        this.channelWaiter = undefined;

        if (ev === undefined) {
            throw new Error(`NCP did not report the move to channel ${channel} (EVT_CHANNEL_CHANGED)`);
        }

        await this.getInfo();

        if (ev.channel !== channel) {
            // the NV already holds the new channel: a reboot of the NCP completes the move
            throw new Error(`NCP radio stayed on channel ${ev.channel} (requested ${channel}); restart the NCP`);
        }
    }

    /** `NWK_GROUP_MEMBERSHIP`; the status (`UNSUPPORTED_COMMAND`/`INVALID_STATE` from older images included). */
    private async groupMembership(op: 1 | 2 | 3, group: number, ep: number): Promise<number> {
        const [status] = await this.api.request(M.Id.NWK_GROUP_MEMBERSHIP, M.NwkGroupMembershipReq, {op, group, ep}, undefined, {
            allow: [Status.SUCCESS, Status.NO_SPACE, Status.INVALID_PARAMETER, Status.INVALID_STATE, Status.UNSUPPORTED_COMMAND],
        });

        if (status !== Status.SUCCESS) {
            logger.debug(`NWK_GROUP_MEMBERSHIP op=${op} group=${group} ep=${ep}: ${Status[status] ?? status}`, NS);
        }

        return status;
    }

    /**
     * genGroups commands herdsman sends to the coordinator's own endpoints (Endpoint.addToGroup etc.), answered locally
     * after `NWK_GROUP_MEMBERSHIP`; `undefined` when the NCP cannot keep group memberships.
     */
    private async coordinatorGroupCommand(endpoint: number, zclFrame: Zcl.Frame): Promise<ZclPayload | undefined> {
        const cmd = zclFrame.command.name;
        const groupId = (zclFrame.payload as {groupid?: number}).groupid ?? 0;
        let status: number;
        let rsp: "addRsp" | "removeRsp" | undefined;

        switch (cmd) {
            case "add":
            case "addIfIdentifying":
                status = await this.groupMembership(1, groupId, endpoint);
                rsp = cmd === "add" ? "addRsp" : undefined;

                if (status === Status.SUCCESS && endpoint === HOST_ENDPOINTS[0].endpoint) {
                    this.coordinatorGroups.add(groupId);
                }

                break;
            case "remove":
                status = await this.groupMembership(2, groupId, endpoint);
                rsp = "removeRsp";

                if (status === Status.SUCCESS && endpoint === HOST_ENDPOINTS[0].endpoint) {
                    this.coordinatorGroups.delete(groupId);
                }

                break;
            case "removeAll":
                status = await this.groupMembership(3, 0, endpoint);

                if (status === Status.SUCCESS && endpoint === HOST_ENDPOINTS[0].endpoint) {
                    this.coordinatorGroups.clear();
                }

                break;
            default:
                return undefined;
        }

        if (status === Status.UNSUPPORTED_COMMAND || status === Status.INVALID_STATE) {
            logger.warning(`This NCP firmware keeps no group memberships for the coordinator (genGroups.${cmd} ignored)`, NS);
            return undefined;
        }

        const zclStatus =
            status === Status.SUCCESS ? Zcl.Status.SUCCESS : status === Status.NO_SPACE ? Zcl.Status.INSUFFICIENT_SPACE : Zcl.Status.INVALID_VALUE;

        if (rsp === undefined || zclFrame.command.response === undefined) {
            if (zclStatus !== Zcl.Status.SUCCESS) {
                throw new Zcl.StatusError(zclStatus);
            }

            return undefined;
        }

        const frame = Zcl.Frame.create(
            Zcl.FrameType.SPECIFIC,
            Zcl.Direction.SERVER_TO_CLIENT,
            true,
            undefined,
            zclFrame.header.transactionSequenceNumber,
            rsp,
            zclFrame.cluster.ID,
            {status: zclStatus, groupid: groupId},
            {},
        );
        const data = frame.toBuffer();

        return {
            clusterID: zclFrame.cluster.ID,
            address: ZSpec.COORDINATOR_ADDRESS,
            header: Zcl.Header.fromBuffer(data),
            data,
            endpoint,
            linkquality: 0xff,
            groupID: 0,
            wasBroadcast: false,
            destinationEndpoint: endpoint,
        };
    }

    private notePermit(seconds: number): void {
        this.permitUntil = seconds > 0 ? Date.now() + seconds * 1000 : undefined;
    }

    /** All pages (16 entries each) of a DIAG table, or `undefined` when the NCP lacks the command. */
    private async diagTable<E>(
        msgId: number,
        reqCodec: Codec<{start: number}>,
        rspCodec: Codec<{total: number; entries: E[]}>,
    ): Promise<E[] | undefined> {
        const all: E[] = [];

        for (let page = 0; page < 16; page++) {
            const rsp = await this.optional(msgId, reqCodec, {start: all.length}, rspCodec);

            if (rsp === undefined) {
                return page === 0 ? undefined : all;
            }

            all.push(...rsp.entries);

            if (rsp.entries.length === 0 || all.length >= rsp.total || all.length >= 0xff) {
                break;
            }
        }

        return all;
    }

    private localZdoContext(): Parameters<typeof localZdoResponse>[0] {
        const neighbors = async (): Promise<
            {ieee: Buffer; nwk: number; deviceType: number; rxOn: number; relationship: number; lqi: number}[] | undefined
        > => {
            const table = await this.diagTable(M.Id.DIAG_GET_NEIGHBORS, M.DiagGetNeighborsReq, M.DiagGetNeighborsRsp);

            if (table === undefined) {
                return undefined;
            }

            const out = table.map((e) => ({
                ieee: e.ieee,
                nwk: e.nwk,
                deviceType: e.deviceType,
                rxOn: e.rxOn,
                relationship: e.relationship,
                lqi: e.lqi,
            }));
            // children that aged out of the neighbour table still belong to the map
            const children = (await this.diagTable(M.Id.DIAG_GET_CHILDREN, M.DiagGetChildrenReq, M.DiagGetChildrenRsp)) ?? [];

            for (const c of children) {
                if (!out.some((n) => n.nwk === c.nwk || n.ieee.equals(c.ieee))) {
                    out.push({
                        ieee: c.ieee,
                        nwk: c.nwk,
                        deviceType: c.capability & 0x02 ? 1 : 2,
                        rxOn: c.capability & 0x08 ? 1 : 0,
                        relationship: 1,
                        lqi: 0,
                    });
                }
            }

            return out;
        };
        const routes = async (): Promise<{dst: number; nextHop: number; status: number; flags: number}[] | undefined> => {
            const table = await this.diagTable(M.Id.DIAG_GET_ROUTES, M.DiagGetRoutesReq, M.DiagGetRoutesRsp);

            return table?.map((e) => ({dst: e.dst, nextHop: e.nextHop, status: e.status, flags: e.flags}));
        };

        return {
            ieee: this.nwk?.ieee ?? Buffer.alloc(8),
            extPanId: this.nwk?.extPanId ?? Buffer.alloc(8),
            manufacturerCode: this.manufacturerID,
            endpoints: [...HOST_ENDPOINTS, GP_LOCAL_ENDPOINT],
            neighbors,
            routes,
        };
    }

    public async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
        await this.whenResumed();

        if (networkAddress === undefined || networkAddress === ZSpec.COORDINATOR_ADDRESS) {
            // 0xFFFC: the NCP opens itself and broadcasts Mgmt_Permit_Joining_req (TC significance)
            const target = networkAddress === undefined ? 0xfffc : 0x0000;
            await this.api.request(M.Id.NWK_PERMIT_JOIN, M.NwkPermitJoinReq, {durationS: Math.min(254, seconds), target, flags: 0x01});
            this.notePermit(networkAddress === undefined ? seconds : 0);
            return;
        }

        const clusterId = Zdo.ClusterId.PERMIT_JOINING_REQUEST;
        const zdoPayload = Zdo.Buffalo.buildRequest(this.hasZdoMessageOverhead, clusterId, seconds, 1, []);
        const result = await this.sendZdo(ZSpec.BLANK_EUI64, networkAddress, clusterId, zdoPayload, false);

        if (!Zdo.Buffalo.checkStatus<Zdo.ClusterId.PERMIT_JOINING_RESPONSE>(result)) {
            throw new Zdo.StatusError(result[0]);
        }
    }

    private profileFor(sourceEndpoint: number | undefined, endpoint: number, profileId: number | undefined): number {
        return profileId ?? (sourceEndpoint === ZSpec.GP_ENDPOINT && endpoint === ZSpec.GP_ENDPOINT ? ZSpec.GP_PROFILE_ID : ZSpec.HA_PROFILE_ID);
    }

    public async sendZclFrameToEndpoint(
        ieeeAddr: string,
        networkAddress: number,
        endpoint: number,
        zclFrame: Zcl.Frame,
        timeout: number,
        disableResponse: boolean,
        disableRecovery: boolean,
        sourceEndpoint?: number,
        profileId?: number,
    ): Promise<ZclPayload | undefined> {
        if (networkAddress === ZSpec.COORDINATOR_ADDRESS) {
            if (zclFrame.cluster.ID === Zcl.Clusters.genGroups.ID && zclFrame.header.isSpecific) {
                return await this.queue.execute(async () => await this.coordinatorGroupCommand(endpoint, zclFrame));
            }

            logger.debug(`~x~> [ZCL clusterId=${zclFrame.cluster.ID} destEp=${endpoint}] Not sending to the coordinator itself`, NS);
            return undefined;
        }

        let commandResponseId: number | undefined;

        if (zclFrame.command.response !== undefined && disableResponse === false) {
            commandResponseId = zclFrame.command.response;
        } else if (!zclFrame.header.frameControl.disableDefaultResponse) {
            commandResponseId = Zcl.Foundation.defaultRsp.ID;
        }

        return await this.queue.execute<ZclPayload | undefined>(async () => {
            logger.debug(
                `~~~> [ZCL to=${ieeeAddr}:${networkAddress} clusterId=${zclFrame.cluster.ID} destEp=${endpoint} sourceEp=${sourceEndpoint}]`,
                NS,
            );

            for (let i = 0; i < 2; i++) {
                const waiter =
                    commandResponseId !== undefined
                        ? this.zclWaitress.waitFor(
                              {
                                  address: networkAddress,
                                  frameType: zclFrame.header.frameControl.frameType,
                                  clusterId: zclFrame.cluster.ID,
                                  endpoint,
                                  commandId: commandResponseId,
                                  defaultRspCommandId: undefined,
                                  transactionSequenceNumber: zclFrame.header.transactionSequenceNumber,
                              },
                              timeout,
                          )
                        : undefined;

                try {
                    await this.sendAps(
                        M.apsDataRequest({
                            dstMode: AddrMode.NWK,
                            dst: networkAddress,
                            dstEp: endpoint,
                            srcEp: sourceEndpoint ?? 1,
                            profile: this.profileFor(sourceEndpoint, endpoint, profileId),
                            cluster: zclFrame.cluster.ID,
                            txOptions: TxOptions.APS_ACK | (i > 0 ? TxOptions.FORCE_ROUTE_DISCOVERY : 0),
                            asdu: zclFrame.toBuffer(),
                        }),
                        Math.max(this.config.confirmTimeoutMs, timeout),
                    );

                    return waiter ? await waiter.start().promise : undefined;
                } catch (error) {
                    if (waiter) {
                        this.zclWaitress.remove(waiter.ID);
                    }

                    if (disableRecovery || i === 1) {
                        throw error;
                    }

                    logger.debug(`Retrying with route discovery after: ${(error as Error).message}`, NS);
                }
            }

            /* v8 ignore next */
            return undefined;
        }, networkAddress);
    }

    public async sendZclFrameToGroup(groupID: number, zclFrame: Zcl.Frame, sourceEndpoint?: number, profileId?: number): Promise<void> {
        await this.queue.execute<void>(async () => {
            if (!this.triedGroups.has(groupID) && !this.coordinatorGroups.has(groupID) && !DEFAULT_GROUPS.includes(groupID)) {
                // as ember: the coordinator joins groups it controls, so devices answering by groupcast reach herdsman
                this.triedGroups.add(groupID);

                if ((await this.groupMembership(1, groupID, HOST_ENDPOINTS[0].endpoint)) === Status.SUCCESS) {
                    this.coordinatorGroups.add(groupID);
                }
            }

            await this.sendAps(
                M.apsDataRequest({
                    dstMode: AddrMode.GROUP,
                    dst: groupID,
                    dstEp: 0xff,
                    srcEp: sourceEndpoint ?? 1,
                    profile: profileId ?? ZSpec.HA_PROFILE_ID,
                    cluster: zclFrame.cluster.ID,
                    nonMemberRadius: 3,
                    asdu: zclFrame.toBuffer(),
                }),
            );
        });
    }

    public async sendZclFrameToAll(
        endpoint: number,
        zclFrame: Zcl.Frame,
        sourceEndpoint: number,
        destination: ZSpec.BroadcastAddress,
        profileId?: number,
    ): Promise<void> {
        await this.queue.execute<void>(async () => {
            await this.sendAps(
                M.apsDataRequest({
                    dstMode: AddrMode.BROADCAST,
                    dst: destination,
                    dstEp: endpoint,
                    srcEp: sourceEndpoint,
                    profile: this.profileFor(sourceEndpoint, endpoint, profileId),
                    cluster: zclFrame.cluster.ID,
                    asdu: zclFrame.toBuffer(),
                }),
            );
        });
    }

    public async setChannelInterPAN(channel: number): Promise<void> {
        await Promise.reject(new Error(`Inter-PAN is not supported by ZRHP v1 (channel ${channel})`));
    }

    public async sendZclFrameInterPANToIeeeAddr(_zclFrame: Zcl.Frame, ieeeAddress: string): Promise<void> {
        await Promise.reject(new Error(`Inter-PAN is not supported by ZRHP v1 (${ieeeAddress})`));
    }

    public async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number, disableResponse: false): Promise<ZclPayload>;
    public async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number, disableResponse: true): Promise<undefined>;
    public async sendZclFrameInterPANBroadcast(_zclFrame: Zcl.Frame, _timeout: number, _disableResponse: boolean): Promise<ZclPayload | undefined> {
        return await Promise.reject(new Error("Inter-PAN is not supported by ZRHP v1"));
    }

    public async restoreChannelInterPAN(): Promise<void> {
        await Promise.reject(new Error("Inter-PAN is not supported by ZRHP v1"));
    }

    // #endregion

    // #region NCP events

    private onEvent(msg: M.Message, body: unknown): void {
        switch (msg.msgId) {
            case M.Id.EVT_APS_DATA_INDICATION:
                this.onIndication(body as StructOf<typeof M.EvtApsDataIndication.fields>);
                break;
            case M.Id.EVT_APS_DATA_CONFIRM: {
                const c = body as Confirm;
                this.confirms.get(c.reqTid)?.(c);
                break;
            }
            case M.Id.EVT_DEVICE_JOINED: {
                const ev = body as StructOf<typeof M.EvtDeviceJoined.fields>;
                const ieeeAddr = hexBE(ev.ieee);

                if (ev.decision !== 0) {
                    logger.warning(`NCP denied the join of ${ieeeAddr}`, NS);
                } else if (ev.joinType === 1) {
                    // secured rejoin: already authorized
                    this.emit("deviceJoined", {networkAddress: ev.nwk, ieeeAddr});
                } else {
                    // wait for the key exchange (EVT_DEVICE_AUTHORIZED) before herdsman starts the interview
                    clearTimeout(this.pendingJoins.get(ieeeAddr));
                    this.pendingJoins.set(
                        ieeeAddr,
                        setTimeout(() => this.emitJoined(ieeeAddr, ev.nwk), AUTHORIZE_WAIT_MS),
                    );
                }

                break;
            }
            case M.Id.EVT_DEVICE_AUTHORIZED: {
                const ev = body as StructOf<typeof M.EvtDeviceAuthorized.fields>;

                if (ev.result === 2) {
                    logger.warning(`Key exchange with ${hexBE(ev.ieee)} failed`, NS);
                }

                this.emitJoined(hexBE(ev.ieee), ev.nwk);
                break;
            }
            case M.Id.EVT_DEVICE_LEFT: {
                const ev = body as StructOf<typeof M.EvtDeviceLeft.fields>;
                const known = !ev.ieee.equals(Buffer.alloc(8));
                this.emit("deviceLeave", known ? {networkAddress: ev.nwk, ieeeAddr: hexBE(ev.ieee)} : {networkAddress: ev.nwk});
                break;
            }
            case M.Id.EVT_CHANNEL_CHANGED: {
                const ev = body as StructOf<typeof M.EvtChannelChanged.fields>;
                logger.info(`NCP radio on channel ${ev.channel} (nwk update id ${ev.nwkUpdateId})`, NS);
                this.channelWaiter?.(ev);
                break;
            }
            case M.Id.EVT_FC_CHECKPOINT: {
                const ev = body as StructOf<typeof M.EvtFcCheckpoint.fields>;
                this.store?.addCheckpoint(ev.domain, ev.keySeq, ev.durableLimit, ev.generation);
                break;
            }
            case M.Id.EVT_TBL_EPOCH_CHANGED:
                this.store?.setMeta({tableEpoch: (body as StructOf<typeof M.EvtTblEpochChanged.fields>).newEpoch});
                break;
            case M.Id.EVT_NETWORK_STATE: {
                const ev = body as StructOf<typeof M.EvtNetworkState.fields>;

                for (const w of [...this.networkWaiters]) {
                    w(ev);
                }

                if (ev.state === 0 && this.started && ev.reqTid === 0) {
                    logger.warning(`NCP network went down (reason ${ev.reason})`, NS);
                }

                break;
            }
            case M.Id.EVT_PERMIT_JOIN_STATE:
                this.notePermit((body as StructOf<typeof M.EvtPermitJoinState.fields>).remainingS);
                break;
            case M.Id.EVT_KEY_FAILURE: {
                const ev = body as StructOf<typeof M.EvtKeyFailure.fields>;
                logger.warning(`Key failure for ${hexBE(ev.ieee)}: reason ${ev.reason}`, NS);
                break;
            }
            case M.Id.EVT_LOG_RECORD: {
                const ev = body as StructOf<typeof M.EvtLogRecord.fields>;
                logger.debug(`NCP log [${ev.level}/${ev.module}]: ${ev.text.toString("utf8")}`, NS);
                break;
            }
            case M.Id.EVT_INDICATIONS_DROPPED: {
                const ev = body as StructOf<typeof M.EvtIndicationsDropped.fields>;
                logger.warning(`NCP dropped ${ev.count} indications (reason ${ev.reason})`, NS);
                break;
            }
            case M.Id.EVT_FATAL: {
                const ev = body as StructOf<typeof M.EvtFatal.fields>;
                logger.error(`NCP fatal error ${ev.kind}/0x${ev.code.toString(16)}: ${ev.text.toString("utf8")}`, NS);
                break;
            }
            default:
                logger.debug(`Unhandled NCP event ${M.nameOf(msg.msgId)}`, NS);
                break;
        }
    }

    private emitJoined(ieeeAddr: string, networkAddress: number): void {
        const timer = this.pendingJoins.get(ieeeAddr);

        if (timer === undefined) {
            return;
        }

        clearTimeout(timer);
        this.pendingJoins.delete(ieeeAddr);
        this.emit("deviceJoined", {networkAddress, ieeeAddr});
    }

    private onIndication(ind: StructOf<typeof M.EvtApsDataIndication.fields>): void {
        if (ind.profile === Zdo.ZDO_PROFILE_ID) {
            if (ind.cluster < 0x8000 && ind.cluster !== Zdo.ClusterId.END_DEVICE_ANNOUNCE) {
                return; // a ZDO request the NCP already answered
            }

            try {
                const result = Zdo.Buffalo.readResponse(this.hasZdoMessageOverhead, ind.cluster, ind.asdu);

                if (ind.cluster === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE) {
                    if (Zdo.Buffalo.checkStatus<Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE>(result)) {
                        this.zdoWaitress.resolve({address: result[1].eui64, clusterId: ind.cluster, response: result, seqNum: ind.asdu[0]});
                    }
                } else {
                    this.zdoWaitress.resolve({address: ind.srcNwk, clusterId: ind.cluster, response: result, seqNum: ind.asdu[0]});
                }

                this.emit("zdoResponse", ind.cluster, result);
            } catch (error) {
                logger.error(`Undecodable ZDO frame 0x${ind.cluster.toString(16)}: ${(error as Error).message}`, NS);
            }

            return;
        }

        const payload: ZclPayload = {
            clusterID: ind.cluster,
            header: Zcl.Header.fromBuffer(ind.asdu),
            address: ind.srcNwk,
            data: ind.asdu,
            endpoint: ind.srcEp,
            linkquality: ind.lqi,
            groupID: ind.dstMode === AddrMode.GROUP ? ind.dst : 0,
            wasBroadcast: ind.dstMode === AddrMode.BROADCAST || (ind.flags & IndicationFlags.BROADCAST) !== 0,
            destinationEndpoint: ind.dstEp,
        };

        if (payload.header !== undefined) {
            this.zclWaitress.resolve(payload as ZclWaitressPayload);
        }

        this.emit("zclPayload", payload);
    }

    /** `TBL_LOOKUP` / `TBL_WRITEBACK` from the NCP (spec 8.5). */
    private async onNcpRequest(msg: M.Message, body: unknown): Promise<Buffer> {
        const store = this.store;

        if (!store) {
            return await Promise.resolve(Buffer.from([Status.INVALID_STATE]));
        }

        if (msg.msgId === M.Id.TBL_WRITEBACK) {
            const wb = body as StructOf<typeof M.TblWritebackReq.fields>;

            if (wb.record.type === RecordType.DEVICE) {
                if (wb.reason === 4) {
                    store.deleteKey(wb.record.value.ieee.toString("hex"));
                } else {
                    store.upsertKey(rowOf(wb.record.value, wb.rev));
                }
            }

            return Buffer.from([Status.SUCCESS]);
        }

        if (msg.msgId === M.Id.TBL_LOOKUP) {
            const lk = body as StructOf<typeof M.TblLookupReq.fields>;
            const row =
                lk.key.keyType === 1
                    ? store.keys.get((lk.key.key as Buffer).toString("hex"))
                    : [...store.keys.values()].find((r) => r.nwk === lk.key.key);

            if (!row?.key) {
                return Buffer.from([Status.NOT_FOUND]);
            }

            const rec: DeviceRecordValue = {
                ieee: Buffer.from(row.ieee, "hex"),
                nwk: row.nwk ?? 0xffff,
                flags: row.nwk !== undefined ? DeviceFlags.NWK_VALID : 0,
                link: linkOf(row, store.lastLimit(2)),
            };

            return M.encodeResponse(M.TblLookupRsp, {rev: row.rev, record: {type: RecordType.DEVICE, value: rec}});
        }

        return Buffer.from([Status.UNSUPPORTED_COMMAND]);
    }

    // #endregion
}

function rowOf(d: DeviceRecordValue, rev: number): LinkKeyRow {
    const link = d.link;

    return {
        ieee: d.ieee.toString("hex"),
        key: link?.key.toString("hex"),
        attrs: link?.attrs ?? KeyAttrs.VERIFIED,
        origin: link?.origin ?? KeyOrigin.TC_GENERATED,
        keySeq: link?.keySeq ?? 0,
        rxFloor: link?.rxFloor ?? 0,
        rev,
        nwk: d.flags & DeviceFlags.NWK_VALID ? d.nwk : undefined,
    };
}

function linkOf(row: LinkKeyRow, apsLimit: number): NonNullable<DeviceRecordValue["link"]> {
    return {
        key: Buffer.from(row.key as string, "hex"),
        keySeq: row.keySeq,
        attrs: row.attrs,
        origin: row.origin,
        txCounter: apsLimit,
        rxFloor: row.rxFloor,
    };
}

/** `stack_specific` sections the NCP does not hold itself (passed through unchanged, spec 9.1). */
function foreignStackSpecific(stackSpecific: Json): Json {
    const out: Json = {};

    for (const [k, v] of Object.entries(stackSpecific ?? {})) {
        if (k === "zigbee_rs") {
            continue;
        }

        if (k === "ezsp") {
            // the NCP keeps the hashed-TCLK seed itself and exports it as a record
            const {hashed_tclk: _seed, ...rest} = v as Json;

            if (Object.keys(rest).length > 0) {
                out[k] = rest;
            }

            continue;
        }

        out[k] = v;
    }

    return out;
}

/**
 * OCB JSON -> herdsman's internal backup model. `stack_specific` sections herdsman does not know (`zigbee_rs`, …) and
 * unknown `metadata.internal` keys travel in the `stackSpecific`/`internal` pass-through fields of the fork.
 */
export function ocbToHerdsmanBackup(ocb: Json): Backup {
    const {zstack, ezsp, ...otherStacks} = ocb.stack_specific ?? {};
    const {date: _date, creation_time: _created, znpVersion: _znp, ezspVersion: _ezspV, ...internal} = ocb.metadata?.internal ?? {};

    return {
        networkOptions: {
            panId: Number.parseInt(ocb.pan_id, 16),
            extendedPanId: Buffer.from(ocb.extended_pan_id, "hex"),
            channelList: ocb.channel_mask,
            networkKey: Buffer.from(ocb.network_key.key, "hex"),
            networkKeyDistribute: false,
        },
        logicalChannel: ocb.channel,
        networkKeyInfo: {sequenceNumber: ocb.network_key.sequence_number, frameCounter: ocb.network_key.frame_counter},
        securityLevel: ocb.security_level,
        networkUpdateId: ocb.nwk_update_id,
        coordinatorIeeeAddress: Buffer.from(ocb.coordinator_ieee, "hex"),
        devices: ocb.devices.map((d: Json) => ({
            networkAddress: d.nwk_address === null ? null : Number.parseInt(d.nwk_address, 16),
            ieeeAddress: Buffer.from(d.ieee_address, "hex"),
            isDirectChild: d.is_child ?? true,
            linkKey: d.link_key
                ? {key: Buffer.from(d.link_key.key, "hex"), rxCounter: d.link_key.rx_counter, txCounter: d.link_key.tx_counter}
                : undefined,
        })),
        ...(zstack?.tclk_seed ? {znp: {trustCenterLinkKeySeed: Buffer.from(zstack.tclk_seed, "hex")}} : {}),
        ...(ezsp?.hashed_tclk ? {ezsp: {hashed_tclk: Buffer.from(ezsp.hashed_tclk, "hex")}} : {}),
        stackSpecific: otherStacks,
        internal,
    };
}

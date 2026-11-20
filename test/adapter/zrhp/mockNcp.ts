/**
 * A scriptable NCP for adapter tests: the real {@link Link} in the NCP role plus a small command dispatcher.
 *
 * The Rust simulator covers the real NCP code paths (formation, backup, restore) but has no radio peers; this mock injects
 * joins, reports, ZDO responses, GP frames and reboots with a persistent network (seamless resume, spec 12.1).
 */

import type {ZrhpPort} from "../../../src/adapter/zrhp/adapter/zrhpAdapter";
import {type Codec, encodeWith} from "../../../src/adapter/zrhp/codec";
import {Kind, LinkEndpoint, Status} from "../../../src/adapter/zrhp/consts";
import {EndpointQueues} from "../../../src/adapter/zrhp/driver";
import {ResetReason} from "../../../src/adapter/zrhp/frame";
import {Link, LinkConfigs} from "../../../src/adapter/zrhp/link";
import * as M from "../../../src/adapter/zrhp/messages";
import {encodeRecord, endRecord, RecordType, type ZrhpRecord} from "../../../src/adapter/zrhp/records";

export const MOCK_IEEE = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);

export interface MockNetwork {
    panId: number;
    extPanId: Buffer;
    channel: number;
    key: Buffer;
    keySeq: number;
    nwkUpdateId: number;
}

type Handler = (req: M.Message) => Buffer | undefined | Promise<Buffer | undefined>;

function now(): number {
    return Math.floor(performance.now() * 1000);
}

/** In-memory host side of the pipe. */
export class MockPort implements ZrhpPort {
    readonly ncp: MockNcp;
    onData: (data: Buffer) => void = () => undefined;
    onClose: (error?: Error) => void = () => undefined;
    isOpen = false;
    openError: Error | undefined;
    readonly lines: [boolean, boolean][] = [];

    constructor(ncp: MockNcp) {
        this.ncp = ncp;
        ncp.port = this;
    }

    async open(): Promise<void> {
        if (this.openError) {
            throw this.openError;
        }

        this.isOpen = true;
        await Promise.resolve();
    }

    async close(): Promise<void> {
        this.isOpen = false;
        await Promise.resolve();
    }

    write(data: Buffer): void {
        if (this.isOpen) {
            setImmediate(() => this.ncp.receive(data));
        }
    }

    async setLines(dtr: boolean, rts: boolean): Promise<void> {
        this.lines.push([dtr, rts]);
        await Promise.resolve();
    }

    /** USB re-enumeration: the port vanishes. */
    vanish(): void {
        this.isOpen = false;
        this.onClose(new Error("port vanished"));
    }

    deliver(data: Buffer): void {
        if (this.isOpen) {
            this.onData(data);
        }
    }
}

export class MockNcp {
    port: MockPort | undefined;
    link: Link;
    readonly queues = new EndpointQueues();
    network: MockNetwork | undefined;
    up = false;
    cookie = 0x5eed0001;
    tableEpoch = 7;
    caps = 0x0008_c010n; // KEY_EXPORT | BACKUP_RESTORE | MANUFACTURER_CODE? (bits 4, 15, 19 cleared below)
    readonly requests: M.Message[] = [];
    readonly overrides = new Map<number, Handler>();
    /** APS confirm status per destination NWK (default success) */
    readonly apsResult = new Map<number, number>();
    busyOnce = 0;
    /** answer `BUSY` to the next n requests of a message (5.10: no room for the response) */
    readonly busy = new Map<number, number>();
    /** extra SYS_NEGOTIATE capacities (e.g. 19 host_response_bytes) */
    capacities: {id: number; value: number}[] = [];
    /** NWK_GET_INFO reports the stored network before NWK_INIT (Z11) */
    infoBeforeInit = false;
    /** NWK_GROUP_MEMBERSHIP implemented: `${group}:${ep}` memberships */
    groups: Set<string> | undefined;
    eventSeq = 0;
    #timer: NodeJS.Timeout | undefined;
    #powered = true;

    constructor() {
        this.caps = (1n << 4n) | (1n << 15n);
        this.link = new Link(LinkConfigs.ncp(), this.cookie, 16, 16);
        this.link.open(now(), ResetReason.POWER_ON);
        this.schedule();
    }

    /** NCP reboot: new cookie, RAM state gone, the network persists in "NV". */
    reboot(cookie = this.cookie + 1): void {
        this.cookie = cookie;
        this.up = false;
        this.queues.clear();
        this.link = new Link(LinkConfigs.ncp(), cookie, 16, 16);
        this.link.open(now(), ResetReason.POWER_ON);
        this.schedule();
    }

    powerOff(): void {
        this.#powered = false;
        clearTimeout(this.#timer);
    }

    stop(): void {
        this.powerOff();
    }

    receive(data: Buffer): void {
        if (!this.#powered) {
            return;
        }

        let off = 0;

        while (off < data.length) {
            off += this.link.pushRx(data.subarray(off), now());
            this.drain();
        }

        this.drain();
        this.schedule();
    }

    private drain(): void {
        for (let ev = this.link.pollEvent(); ev !== undefined; ev = this.link.pollEvent()) {
            if (ev.type === "established") {
                this.event(M.Id.EVT_NCP_READY, M.EvtNcpReady, {
                    ncpCookie: this.cookie,
                    resetReason: 1,
                    networkState: this.network ? (this.up ? 2 : 1) : 0,
                    tableEpoch: this.tableEpoch,
                    nwkFcLimit: 1024,
                    apsFcLimit: 1024,
                    dirtyWritebacks: 0,
                    droppedIndications: 0,
                });
            } else if (ev.type === "data") {
                for (const msg of M.parseBatch(ev.payload)) {
                    if (msg.kind === Kind.REQUEST) {
                        this.requests.push(msg);
                        this.handle(ev.endpoint, msg).catch(() => undefined);
                    }
                }
            }
        }
    }

    schedule(): void {
        clearTimeout(this.#timer);

        if (!this.#powered) {
            return;
        }

        const t = now();

        for (let w = this.link.pollTransmit(t, this.queues); w !== undefined; w = this.link.pollTransmit(t, this.queues)) {
            this.port?.deliver(w);
        }

        this.drain();
        const d = this.link.nextDeadline();

        if (d !== undefined) {
            this.#timer = setTimeout(() => this.schedule(), Math.max(1, Math.ceil((d - now()) / 1000)));
        }
    }

    event<T>(msgId: M.Id, codec: Codec<T>, value: T): void {
        const ep = M.homeEndpoint(msgId) ?? LinkEndpoint.ZIGBEE;
        this.eventSeq = (this.eventSeq + 1) & 0xffff;
        this.queues.push(ep, M.encodeMessage({kind: Kind.EVENT, msgId, tid: this.eventSeq, payload: encodeWith(codec, value)}));
        setImmediate(() => this.schedule());
    }

    /** `EVT_APS_DATA_INDICATION` from a device. */
    indicate(v: Partial<Parameters<typeof M.EvtApsDataIndication.make>[0]>): void {
        this.event(
            M.Id.EVT_APS_DATA_INDICATION,
            M.EvtApsDataIndication,
            M.EvtApsDataIndication.make({dstMode: 2, dstEp: 1, srcEp: 1, lqi: 200, rssi: -50, profile: 0x0104, ...v}),
        );
    }

    count(msgId: M.Id): number {
        return this.requests.filter((r) => r.msgId === msgId).length;
    }

    last(msgId: M.Id): M.Message | undefined {
        return this.requests.filter((r) => r.msgId === msgId).at(-1);
    }

    private respond(ep: LinkEndpoint, req: M.Message, payload: Buffer): void {
        this.queues.push(ep, M.encodeMessage({kind: Kind.RESPONSE, msgId: req.msgId, tid: req.tid, payload}));
        setImmediate(() => this.schedule());
    }

    private async handle(ep: LinkEndpoint, req: M.Message): Promise<void> {
        const override = this.overrides.get(req.msgId);
        const payload = override ? await override(req) : this.dispatch(req);

        if (payload !== undefined) {
            this.respond(ep, req, payload);
        }
    }

    private networkState(state: number, reqTid = 0): void {
        this.event(M.Id.EVT_NETWORK_STATE, M.EvtNetworkState, {state, reason: 0, zbStatus: 0, reqTid});
    }

    exportRecords(): ZrhpRecord[] {
        const n = this.network as MockNetwork;
        const recs: ZrhpRecord[] = [
            {type: RecordType.NODE, value: {ieee: MOCK_IEEE, nwk: 0, logicalType: 0, flags: 0}},
            {
                type: RecordType.NETWORK,
                value: {
                    panId: n.panId,
                    extPanId: n.extPanId,
                    channel: n.channel,
                    channelMask: 1 << n.channel,
                    nwkUpdateId: n.nwkUpdateId,
                    nwkManager: 0,
                    securityLevel: 5,
                    txPower: 0x7f,
                },
            },
            {type: RecordType.NETWORK_KEY, value: {key: n.key, seq: n.keySeq, txCounter: 5120, flags: 1}},
            {type: RecordType.TC_LINK_KEY, value: {key: Buffer.from("ZigBeeAlliance09"), tcIeee: MOCK_IEEE, txCounter: 3072, flags: 0}},
            {type: RecordType.RS_PARAMS, value: {fcStride: 1024, tableEpoch: this.tableEpoch, nwkFcLimit: 5120, apsFcLimit: 3072, flags: 0}},
            {
                type: RecordType.DEVICE,
                value: {
                    ieee: Buffer.from("0807060504030201", "hex"),
                    nwk: 0x1234,
                    flags: 0x09,
                    child: {capability: 0x80, timeoutExp: 8},
                    link: {key: Buffer.alloc(16, 0xab), keySeq: 0, attrs: 2, origin: 2, txCounter: 3072, rxFloor: 9},
                },
            },
        ];

        return [...recs, endRecord(recs.map(encodeRecord))];
    }

    private dispatch(req: M.Message): Buffer | undefined {
        const ok = Buffer.from([Status.SUCCESS]);
        const busy = this.busy.get(req.msgId) ?? 0;

        if (busy > 0) {
            this.busy.set(req.msgId, busy - 1);
            return Buffer.from([Status.BUSY]);
        }

        switch (req.msgId) {
            case M.Id.SYS_NEGOTIATE:
                return M.encodeResponse(M.SysNegotiateRsp, {
                    major: 1,
                    minor: 0,
                    ncpCaps: this.caps,
                    capacities: [{id: 1, value: 4}, {id: 7, value: 1024}, ...this.capacities],
                    fw: Buffer.from("mock/1.0"),
                    buildId: Buffer.alloc(8, 1),
                    chip: 1,
                });
            case M.Id.SYS_GET_INFO:
                return M.encodeResponse(
                    M.SysGetInfoRsp,
                    M.SysGetInfoRsp.make({
                        ieeeFactory: MOCK_IEEE,
                        ieeeActive: MOCK_IEEE,
                        transport: 1,
                        board: Buffer.from("devkit"),
                        product: Buffer.from("mock NCP"),
                    }),
                );
            case M.Id.SYS_ECHO:
                return Buffer.concat([ok, req.payload]);
            case M.Id.SYS_RESET:
                setTimeout(() => this.reboot(), 5);
                return ok;
            case M.Id.NWK_GET_INFO: {
                const n = this.network;
                return M.encodeResponse(
                    M.NwkGetInfoRsp,
                    M.NwkGetInfoRsp.make(
                        n && this.up
                            ? {
                                  state: 2,
                                  panId: n.panId,
                                  extPanId: n.extPanId,
                                  channel: n.channel,
                                  ieee: MOCK_IEEE,
                                  nwkUpdateId: n.nwkUpdateId,
                                  keySeq: n.keySeq,
                                  securityLevel: 5,
                                  stackProfile: 2,
                              }
                            : n && this.infoBeforeInit
                              ? {
                                    state: 1,
                                    panId: n.panId,
                                    extPanId: n.extPanId,
                                    channel: n.channel,
                                    ieee: MOCK_IEEE,
                                    nwkUpdateId: n.nwkUpdateId,
                                    keySeq: n.keySeq,
                                    securityLevel: 5,
                                    stackProfile: 2,
                                }
                              : {state: n ? 1 : 0, ieee: MOCK_IEEE, securityLevel: 5, stackProfile: 2},
                    ),
                );
            }
            case M.Id.NWK_INIT: {
                if (!this.network) {
                    return M.encodeResponse(M.NwkInitRsp, {networkState: 0}, Status.NOT_FORMED);
                }

                setTimeout(() => {
                    this.up = true;
                    this.networkState(2);
                }, 2);
                return M.encodeResponse(M.NwkInitRsp, {networkState: this.up ? 2 : 1});
            }
            case M.Id.NWK_FORM: {
                const f = M.NwkFormReq.decode(req.payload);
                this.network = {
                    panId: f.panId,
                    extPanId: f.extPanId,
                    channel: Math.log2(f.channelMask),
                    key: f.networkKey,
                    keySeq: 0,
                    nwkUpdateId: 0,
                };
                setTimeout(() => {
                    this.up = true;
                    this.networkState(2, req.tid);
                }, 2);
                return ok;
            }
            case M.Id.NWK_LEAVE_RESET:
                this.network = undefined;
                this.up = false;
                return ok;
            case M.Id.SEC_GET_NETWORK_KEY:
                return M.encodeResponse(M.SecGetNetworkKeyRsp, {key: this.network?.key ?? Buffer.alloc(16), seq: 0, nwkFcLimit: 1024});
            case M.Id.NWK_ADD_ENDPOINT:
            case M.Id.GP_SINK_CONFIG:
            case M.Id.NWK_PERMIT_JOIN:
            case M.Id.SEC_LOCK_KEY_EXPORT:
                return ok;
            case M.Id.NWK_GROUP_MEMBERSHIP: {
                if (!this.groups) {
                    return Buffer.from([Status.UNSUPPORTED_COMMAND]);
                }

                if (!this.up) {
                    return Buffer.from([Status.INVALID_STATE]);
                }

                const g = M.NwkGroupMembershipReq.decode(req.payload);

                if (g.ep === 0 || (g.ep > 240 && g.ep !== 242) || g.group > 0xfff7) {
                    return Buffer.from([Status.INVALID_PARAMETER]);
                }

                if (g.op === 1) {
                    if (!this.groups.has(`${g.group}:${g.ep}`) && this.groups.size >= 4) {
                        return Buffer.from([Status.NO_SPACE]);
                    }

                    this.groups.add(`${g.group}:${g.ep}`);
                } else if (g.op === 2) {
                    this.groups.delete(`${g.group}:${g.ep}`);
                } else {
                    for (const m of [...this.groups].filter((m) => m.endsWith(`:${g.ep}`))) {
                        this.groups.delete(m);
                    }
                }

                return ok;
            }
            case M.Id.TBL_SYNC:
                return M.encodeResponse(M.TblSyncRsp, M.TblSyncRsp.make({ncpTableEpoch: this.tableEpoch}));
            case M.Id.TBL_PUSH:
                return M.encodeResponse(M.TblPushRsp, {results: [{status: 0, rev: 1}]});
            case M.Id.BKP_EXPORT_BEGIN:
                return M.encodeResponse(M.BkpExportBeginRsp, {txn: 3, recordCount: 7});
            case M.Id.BKP_EXPORT_READ:
                return M.encodeResponse(M.BkpExportReadRsp, {more: 0, records: Buffer.concat(this.exportRecords().map(encodeRecord))});
            case M.Id.BKP_EXPORT_END:
                return ok;
            case M.Id.APS_DATA_REQUEST: {
                if (this.busyOnce > 0) {
                    this.busyOnce--;
                    return Buffer.from([Status.BUSY]);
                }

                const r = M.decodeMessage(req) as M.ApsDataRequestValue;
                const dst = typeof r.dst === "number" ? r.dst : 0;
                const status = this.apsResult.get(dst) ?? 0;
                setTimeout(
                    () =>
                        this.event(M.Id.EVT_APS_DATA_CONFIRM, M.EvtApsDataConfirm, {
                            reqTid: req.tid,
                            status: status === 0 ? 0 : 1,
                            zbStatus: status,
                            apsCounter: 1,
                            dstNwk: dst,
                            flags: 1,
                            elapsedMs: 3,
                        }),
                    2,
                );
                return ok;
            }
            default:
                return Buffer.from([Status.UNSUPPORTED_COMMAND]);
        }
    }
}

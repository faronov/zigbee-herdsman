/**
 * ZRHP message layer (spec 6) and the v1 command set (spec 7-9).
 *
 * Layouts mirror `zigbee-zrhp/src/msg`. Request and event codecs carry their whole payload; response codecs carry the fields
 * after the leading `status` byte ({@link encodeResponse} / {@link decodeResponse}).
 */

import {
    type Codec,
    CodecError,
    decodeWith,
    encodeWith,
    epid,
    type Fields,
    i8,
    ieee,
    key16,
    listOf,
    lv8,
    lv16,
    Reader,
    rest,
    type StructCodec,
    sha256,
    struct,
    u8,
    u16,
    u32,
    u64,
} from "./codec";
import {AddrMode, Kind, LinkEndpoint, TxOptions} from "./consts";
import {GpTranslation, gpdId, record} from "./records";

export const MSG_HEADER_LEN = 7;
export const MAX_MESSAGE_PAYLOAD = 640 - MSG_HEADER_LEN;
export const FLAG_RETRY = 0x20;

export enum Id {
    SYS_NEGOTIATE = 0x0001,
    SYS_GET_INFO = 0x0002,
    SYS_RESET = 0x0003,
    SYS_GET_STATUS = 0x0004,
    SYS_SET_CONFIG = 0x0005,
    SYS_GET_CONFIG = 0x0006,
    SYS_ECHO = 0x0007,
    SYS_SET_IEEE = 0x0008,
    SYS_SET_UART = 0x0009,
    EVT_NCP_READY = 0x0080,
    EVT_INDICATIONS_DROPPED = 0x0081,
    EVT_FATAL = 0x0082,
    EVT_PROTOCOL_ERROR = 0x0083,
    NWK_INIT = 0x0101,
    NWK_FORM = 0x0102,
    NWK_LEAVE_RESET = 0x0103,
    NWK_GET_INFO = 0x0104,
    NWK_PERMIT_JOIN = 0x0105,
    NWK_ENERGY_SCAN = 0x0106,
    NWK_CHANGE_CHANNEL = 0x0107,
    NWK_SET_TX_POWER = 0x0108,
    NWK_CONCENTRATOR = 0x0109,
    NWK_ACTIVE_SCAN = 0x010a,
    NWK_ADD_ENDPOINT = 0x010b,
    NWK_SET_MANUFACTURER_CODE = 0x010c,
    NWK_GROUP_MEMBERSHIP = 0x010d,
    NWK_REMOVE_DEVICE = 0x010e,
    EVT_NETWORK_STATE = 0x0180,
    EVT_DEVICE_JOINED = 0x0181,
    EVT_DEVICE_AUTHORIZED = 0x0182,
    EVT_DEVICE_LEFT = 0x0183,
    EVT_ADDRESS_CHANGED = 0x0184,
    EVT_ROUTE_RECORD = 0x0185,
    EVT_NWK_STATUS = 0x0186,
    EVT_PAN_ID_CONFLICT = 0x0187,
    EVT_PERMIT_JOIN_STATE = 0x0188,
    EVT_CHANNEL_CHANGED = 0x0189,
    EVT_ENERGY_SCAN_RESULT = 0x018a,
    APS_DATA_REQUEST = 0x0201,
    EVT_APS_DATA_INDICATION = 0x0280,
    EVT_APS_DATA_CONFIRM = 0x0281,
    ZDO_CONFIG = 0x0301,
    SEC_GET_NETWORK_KEY = 0x0401,
    SEC_SET_TC_POLICY = 0x0402,
    SEC_ADD_INSTALL_CODE = 0x0403,
    SEC_ADD_LINK_KEY = 0x0404,
    SEC_REMOVE_LINK_KEY = 0x0405,
    SEC_ROTATE_NETWORK_KEY = 0x0406,
    SEC_GET_LINK_KEY = 0x0407,
    SEC_GET_FRAME_COUNTERS = 0x0408,
    SEC_DERIVE_EZSP_KEY = 0x0409,
    SEC_LOCK_KEY_EXPORT = 0x040a,
    EVT_LINK_KEY_UPDATED = 0x0480,
    EVT_KEY_FAILURE = 0x0481,
    EVT_NETWORK_KEY_SWITCHED = 0x0482,
    EVT_FC_CHECKPOINT = 0x0483,
    TBL_LOOKUP = 0x0501,
    TBL_WRITEBACK = 0x0502,
    TBL_PUSH = 0x0503,
    TBL_INVALIDATE = 0x0504,
    TBL_SYNC = 0x0505,
    TBL_READ = 0x0506,
    TBL_STATS = 0x0507,
    EVT_TBL_EPOCH_CHANGED = 0x0580,
    EVT_TBL_PAGING = 0x0581,
    BKP_EXPORT_BEGIN = 0x0601,
    BKP_EXPORT_READ = 0x0602,
    BKP_EXPORT_END = 0x0603,
    BKP_RESTORE_BEGIN = 0x0611,
    BKP_RESTORE_PUT = 0x0612,
    BKP_RESTORE_COMMIT = 0x0613,
    BKP_RESTORE_ABORT = 0x0614,
    DIAG_GET_COUNTERS = 0x0701,
    DIAG_RESET_COUNTERS = 0x0702,
    DIAG_GET_NEIGHBORS = 0x0703,
    DIAG_GET_ROUTES = 0x0704,
    DIAG_GET_CHILDREN = 0x0705,
    DIAG_GET_SOURCE_ROUTES = 0x0706,
    FW_BEGIN = 0x0801,
    FW_WRITE = 0x0802,
    FW_FINISH = 0x0803,
    FW_ACTIVATE = 0x0804,
    FW_CONFIRM = 0x0805,
    FW_ABORT = 0x0806,
    FW_GET_SLOTS = 0x0807,
    LOG_CONFIG = 0x0901,
    EVT_LOG_RECORD = 0x0980,
    EVT_LOG_DROPPED = 0x0981,
    GP_SINK_CONFIG = 0x0a01,
    GP_SET_SHARED_KEY = 0x0a02,
    GP_SINK_COMMISSIONING = 0x0a03,
    GP_SINK_TABLE_READ = 0x0a04,
    GP_SINK_TABLE_PUT = 0x0a05,
    GP_SINK_REMOVE = 0x0a06,
    GP_PROXY_TABLE_READ = 0x0a07,
    GP_PAIRING_CONFIGURATION = 0x0a08,
    GP_SEND_PAIRING = 0x0a09,
    GP_TRANSLATION_UPDATE = 0x0a0a,
    GP_TRANSLATION_REQUEST = 0x0a0b,
    GP_REMOTE_SINK_TABLE_REQUEST = 0x0a0c,
    GP_REMOTE_PROXY_TABLE_REQUEST = 0x0a0d,
    EVT_GP_FRAME = 0x0a80,
    EVT_GP_COMMISSIONING = 0x0a81,
    EVT_GP_COMMISSIONED = 0x0a82,
    EVT_GP_COMMISSIONING_FAILED = 0x0a83,
    EVT_GP_DECOMMISSIONED = 0x0a84,
    EVT_GP_REMOTE_STATUS = 0x0a85,
    EVT_GP_REMOTE_SINK_TABLE = 0x0a86,
    EVT_GP_REMOTE_PROXY_TABLE = 0x0a87,
    EVT_GP_REMOTE_TRANSLATION_TABLE = 0x0a88,
}

export function nameOf(msgId: number): string {
    return Id[msgId] ?? `0x${msgId.toString(16).padStart(4, "0")}`;
}

const GROUP_ENDPOINT: Record<number, LinkEndpoint> = {
    0: LinkEndpoint.SYSTEM,
    1: LinkEndpoint.ZIGBEE,
    2: LinkEndpoint.ZIGBEE,
    3: LinkEndpoint.ZIGBEE,
    4: LinkEndpoint.ZIGBEE,
    5: LinkEndpoint.TABLES,
    6: LinkEndpoint.BULK,
    7: LinkEndpoint.SYSTEM,
    8: LinkEndpoint.BULK,
    9: LinkEndpoint.LOG,
    10: LinkEndpoint.ZIGBEE,
};

/** The link endpoint a message ID belongs to (spec 6.7). */
export function homeEndpoint(msgId: number): LinkEndpoint | undefined {
    return GROUP_ENDPOINT[msgId >> 8];
}

// #region Message header and batches

export interface Message {
    kind: Kind;
    msgId: number;
    tid: number;
    payload: Buffer;
    retry?: boolean;
}

export function encodeMessage(m: Message): Buffer {
    const head = Buffer.alloc(MSG_HEADER_LEN);
    head[0] = (m.kind << 6) | (m.retry ? FLAG_RETRY : 0);
    head.writeUInt16LE(m.msgId, 1);
    head.writeUInt16LE(m.tid, 3);
    head.writeUInt16LE(m.payload.length, 5);

    return Buffer.concat([head, m.payload]);
}

/** The message lengths do not tile the payload (spec 6.1). */
export class BatchError extends Error {}

/** Parse a DATA payload atomically; throws {@link BatchError} if malformed. */
export function parseBatch(payload: Buffer): Message[] {
    if (payload.length === 0) {
        throw new BatchError("empty");
    }

    const out: Message[] = [];
    let pos = 0;

    while (pos < payload.length) {
        if (pos + MSG_HEADER_LEN > payload.length) {
            throw new BatchError("truncated header");
        }

        const flags = payload[pos];
        const kind = flags >> 6;

        if (kind === 3) {
            throw new BatchError("reserved kind");
        }

        if (flags & 0x1f) {
            throw new BatchError("reserved flags");
        }

        const end = pos + MSG_HEADER_LEN + payload.readUInt16LE(pos + 5);

        if (end > payload.length) {
            throw new BatchError("truncated message");
        }

        out.push({
            kind,
            msgId: payload.readUInt16LE(pos + 1),
            tid: payload.readUInt16LE(pos + 3),
            payload: Buffer.from(payload.subarray(pos + MSG_HEADER_LEN, end)),
            retry: (flags & FLAG_RETRY) !== 0,
        });
        pos = end;
    }

    return out;
}

// #endregion

// #region Definitions

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous codec tables
type AnyCodec = Codec<any>;

export const REQUESTS: Record<number, AnyCodec> = {};
export const RESPONSES: Record<number, AnyCodec> = {};
export const EVENTS: Record<number, AnyCodec> = {};

function req<F extends Fields>(id: Id, fields: F): StructCodec<F> {
    const c = struct(fields);
    REQUESTS[id] = c;

    return c;
}

function rsp<F extends Fields>(id: Id, fields: F): StructCodec<F> {
    const c = struct(fields);
    RESPONSES[id] = c;

    return c;
}

function evt<F extends Fields>(id: Id, fields: F): StructCodec<F> {
    const c = struct(fields);
    EVENTS[id] = c;

    return c;
}

// SYSTEM (7.1)
export const CapacityEntry = struct({id: u8, value: u32});
export const SysNegotiateReq = req(Id.SYS_NEGOTIATE, {majorMin: u8, majorMax: u8, hostCaps: u64, name: lv8});
export const SysNegotiateRsp = rsp(Id.SYS_NEGOTIATE, {
    major: u8,
    minor: u8,
    ncpCaps: u64,
    capacities: listOf(CapacityEntry),
    fw: lv8,
    buildId: epid,
    chip: u8,
});
export const SysGetInfoReq = req(Id.SYS_GET_INFO, {});
export const SysGetInfoRsp = rsp(Id.SYS_GET_INFO, {
    ieeeFactory: ieee,
    ieeeActive: ieee,
    ieeeSource: u8,
    chipRev: u16,
    flashSize: u32,
    transport: u8,
    uartBaud: u32,
    uartFlow: u8,
    board: lv8,
    product: lv8,
});
export const SysResetReq = req(Id.SYS_RESET, {mode: u8, confirm: u32});
export const SysGetStatusReq = req(Id.SYS_GET_STATUS, {});
export const SysGetStatusRsp = rsp(Id.SYS_GET_STATUS, {
    networkState: u8,
    uptimeS: u32,
    freeApsSlots: u16,
    hostAbsentQueue: u16,
    dirtyWritebacks: u16,
    restoreInProgress: u8,
    flags: u8,
});
export const SysEchoReq = req(Id.SYS_ECHO, {data: rest});
export const SysEchoRsp = rsp(Id.SYS_ECHO, {data: rest});
export const SysSetIeeeReq = req(Id.SYS_SET_IEEE, {ieee});
export const SysSetUartReq = req(Id.SYS_SET_UART, {baud: u32, flow: u8, applyDelayMs: u16});
export const EvtNcpReady = evt(Id.EVT_NCP_READY, {
    ncpCookie: u32,
    resetReason: u8,
    networkState: u8,
    tableEpoch: u32,
    nwkFcLimit: u32,
    apsFcLimit: u32,
    dirtyWritebacks: u16,
    droppedIndications: u32,
});
export const EvtIndicationsDropped = evt(Id.EVT_INDICATIONS_DROPPED, {endpoint: u8, reason: u8, count: u32, firstMs: u32, lastMs: u32});
export const EvtFatal = evt(Id.EVT_FATAL, {kind: u8, code: u32, text: lv8});
export const EvtProtocolError = evt(Id.EVT_PROTOCOL_ERROR, {endpoint: u8, msgId: u16, reason: u8});

// NETWORK (7.2)
export const NwkInitReq = req(Id.NWK_INIT, {nwkFcFloor: u32, apsFcFloor: u32});
export const NwkInitRsp = rsp(Id.NWK_INIT, {networkState: u8});
export const NwkFormReq = req(Id.NWK_FORM, {
    channelMask: u32,
    panId: u16,
    extPanId: epid,
    networkKey: key16,
    keySeq: u8,
    nwkUpdateId: u8,
    txPower: i8,
    nwkManager: u16,
});
export const NwkLeaveResetReq = req(Id.NWK_LEAVE_RESET, {flags: u8});
export const NwkGetInfoReq = req(Id.NWK_GET_INFO, {});
export const NwkGetInfoRsp = rsp(Id.NWK_GET_INFO, {
    state: u8,
    panId: u16,
    extPanId: epid,
    channel: u8,
    channelMask: u32,
    short: u16,
    ieee,
    nwkUpdateId: u8,
    nwkManager: u16,
    keySeq: u8,
    securityLevel: u8,
    txPower: i8,
    stackProfile: u8,
});
export const NwkPermitJoinReq = req(Id.NWK_PERMIT_JOIN, {durationS: u8, target: u16, flags: u8});
export const NwkChangeChannelReq = req(Id.NWK_CHANGE_CHANNEL, {channel: u8, nwkUpdateId: u8});
export const NwkSetTxPowerReq = req(Id.NWK_SET_TX_POWER, {dbm: i8});
export const NwkSetTxPowerRsp = rsp(Id.NWK_SET_TX_POWER, {appliedDbm: i8});
export const NwkAddEndpointReq = req(Id.NWK_ADD_ENDPOINT, {
    ep: u8,
    profile: u16,
    deviceId: u16,
    version: u8,
    inClusters: listOf(u16),
    outClusters: listOf(u16),
});
export const NwkSetManufacturerCodeReq = req(Id.NWK_SET_MANUFACTURER_CODE, {code: u16});
export const NwkGroupMembershipReq = req(Id.NWK_GROUP_MEMBERSHIP, {op: u8, group: u16, ep: u8});
export const NwkRemoveDeviceReq = req(Id.NWK_REMOVE_DEVICE, {nwk: u16, ieee, flags: u8});
export const EvtNetworkState = evt(Id.EVT_NETWORK_STATE, {state: u8, reason: u8, zbStatus: u8, reqTid: u16});
export const EvtDeviceJoined = evt(Id.EVT_DEVICE_JOINED, {nwk: u16, ieee, parentNwk: u16, joinType: u8, capability: u8, decision: u8});
export const EvtDeviceAuthorized = evt(Id.EVT_DEVICE_AUTHORIZED, {nwk: u16, ieee, result: u8, linkKeyType: u8});
export const EvtDeviceLeft = evt(Id.EVT_DEVICE_LEFT, {nwk: u16, ieee, flags: u8, reason: u8});
export const EvtAddressChanged = evt(Id.EVT_ADDRESS_CHANGED, {ieee, oldNwk: u16, newNwk: u16, cause: u8});
export const EvtRouteRecord = evt(Id.EVT_ROUTE_RECORD, {srcNwk: u16, srcIeee: ieee, relays: listOf(u16)});
export const EvtPermitJoinState = evt(Id.EVT_PERMIT_JOIN_STATE, {remainingS: u8});
export const EvtChannelChanged = evt(Id.EVT_CHANNEL_CHANGED, {channel: u8, nwkUpdateId: u8, reqTid: u16});

// DATA (7.3)
export interface ApsDataRequestValue {
    dstMode: AddrMode;
    /** group / NWK / broadcast address, or on-air IEEE bytes for mode 3 */
    dst: number | Buffer;
    dstEp: number;
    srcEp: number;
    profile: number;
    cluster: number;
    txOptions: number;
    radius: number;
    nonMemberRadius: number;
    priority: number;
    relays?: number[];
    alias?: [src: number, seq: number];
    asdu: Buffer;
}

/** `APS_DATA_REQUEST`; tx_options bits 4 and 6 follow `alias`/`relays`. */
export const ApsDataRequest: Codec<ApsDataRequestValue> = {
    write: (w, v) => {
        let opts = v.txOptions & ~(TxOptions.SOURCE_ROUTE | TxOptions.USE_ALIAS);

        if (v.relays !== undefined) {
            opts |= TxOptions.SOURCE_ROUTE;
        }

        if (v.alias !== undefined) {
            opts |= TxOptions.USE_ALIAS;
        }

        w.u8(v.dstMode);

        if (v.dstMode === AddrMode.IEEE) {
            ieee.write(w, v.dst as Buffer);
        } else if (v.dstMode === AddrMode.GROUP || v.dstMode === AddrMode.NWK || v.dstMode === AddrMode.BROADCAST) {
            w.u16(v.dst as number);
        } else {
            throw new CodecError(`invalid dst_mode ${v.dstMode}`);
        }

        w.u8(v.dstEp);
        w.u8(v.srcEp);
        w.u16(v.profile);
        w.u16(v.cluster);
        w.u8(opts);
        w.u8(v.radius);
        w.u8(v.nonMemberRadius);
        w.u8(v.priority);

        if (v.relays !== undefined) {
            listOf(u16).write(w, v.relays);
        }

        if (v.alias !== undefined) {
            w.u16(v.alias[0]);
            w.u8(v.alias[1]);
        }

        lv16.write(w, v.asdu);
    },
    read: (r) => {
        const dstMode = r.u8();
        let dst: number | Buffer;

        if (dstMode === AddrMode.IEEE) {
            dst = r.bytes(8);
        } else if (dstMode === AddrMode.GROUP || dstMode === AddrMode.NWK || dstMode === AddrMode.BROADCAST) {
            dst = r.u16();
        } else {
            throw new CodecError(`invalid dst_mode ${dstMode}`);
        }

        const out: ApsDataRequestValue = {
            dstMode,
            dst,
            dstEp: r.u8(),
            srcEp: r.u8(),
            profile: r.u16(),
            cluster: r.u16(),
            txOptions: r.u8(),
            radius: r.u8(),
            nonMemberRadius: r.u8(),
            priority: r.u8(),
            asdu: Buffer.alloc(0),
        };

        if (out.txOptions & TxOptions.SOURCE_ROUTE) {
            out.relays = listOf(u16).read(r);
        }

        if (out.txOptions & TxOptions.USE_ALIAS) {
            out.alias = [r.u16(), r.u8()];
        }

        out.asdu = lv16.read(r);

        return out;
    },
    def: () => ({
        dstMode: AddrMode.NWK,
        dst: 0,
        dstEp: 0,
        srcEp: 0,
        profile: 0,
        cluster: 0,
        txOptions: 0,
        radius: 0,
        nonMemberRadius: 0,
        priority: 1,
        asdu: Buffer.alloc(0),
    }),
};
REQUESTS[Id.APS_DATA_REQUEST] = ApsDataRequest;

export function apsDataRequest(v: Partial<ApsDataRequestValue>): ApsDataRequestValue {
    return {...ApsDataRequest.def(), ...v};
}

export const EvtApsDataIndication = evt(Id.EVT_APS_DATA_INDICATION, {
    dstMode: u8,
    dst: u16,
    dstEp: u8,
    srcNwk: u16,
    srcIeee: ieee,
    srcEp: u8,
    profile: u16,
    cluster: u16,
    flags: u8,
    lqi: u8,
    rssi: i8,
    lastHopNwk: u16,
    apsCounter: u8,
    keySource: u8,
    rxTimeMs: u32,
    asdu: lv16,
});
export const EvtApsDataConfirm = evt(Id.EVT_APS_DATA_CONFIRM, {
    reqTid: u16,
    status: u8,
    zbStatus: u8,
    apsCounter: u8,
    dstNwk: u16,
    flags: u8,
    elapsedMs: u16,
});
export const ZdoConfigReq = req(Id.ZDO_CONFIG, {flags: u8});

// SECURITY (7.5)
export const SecGetNetworkKeyReq = req(Id.SEC_GET_NETWORK_KEY, {which: u8});
export const SecGetNetworkKeyRsp = rsp(Id.SEC_GET_NETWORK_KEY, {key: key16, seq: u8, nwkFcLimit: u32});
export const SecSetTcPolicyReq = req(Id.SEC_SET_TC_POLICY, {
    allowJoin: u8,
    requireTclkUpdate: u8,
    allowTcRejoin: u8,
    allowAppLinkKeys: u8,
    joinTimeoutS: u16,
});
export const SecAddInstallCodeReq = req(Id.SEC_ADD_INSTALL_CODE, {ieee, code: lv8});
export const SecAddInstallCodeRsp = rsp(Id.SEC_ADD_INSTALL_CODE, {derivedKey: key16});
export const SecAddLinkKeyReq = req(Id.SEC_ADD_LINK_KEY, {ieee, key: key16, keyType: u8, attrs: u8, rxFloor: u32, flags: u8});
export const SecRemoveLinkKeyReq = req(Id.SEC_REMOVE_LINK_KEY, {ieee});
export const SecGetFrameCountersReq = req(Id.SEC_GET_FRAME_COUNTERS, {});
export const SecGetFrameCountersRsp = rsp(Id.SEC_GET_FRAME_COUNTERS, {
    nwkCurrent: u32,
    nwkLimit: u32,
    apsCurrent: u32,
    apsLimit: u32,
    stride: u32,
});
export const SecLockKeyExportReq = req(Id.SEC_LOCK_KEY_EXPORT, {confirm: u32});
export const EvtKeyFailure = evt(Id.EVT_KEY_FAILURE, {ieee, nwk: u16, reason: u8});
export const EvtFcCheckpoint = evt(Id.EVT_FC_CHECKPOINT, {domain: u8, keySeq: u8, durableLimit: u32, generation: u32});

// TABLES (8.5)
export interface TableKeyValue {
    keyType: 1 | 2;
    key: Buffer | number;
}

/** `u8 key_type (1 IEEE, 2 NWK), key[8|2]`. */
export const tableKey: Codec<TableKeyValue> = {
    write: (w, v) => {
        w.u8(v.keyType);

        if (v.keyType === 1) {
            ieee.write(w, v.key as Buffer);
        } else {
            w.u16(v.key as number);
        }
    },
    read: (r) => {
        const keyType = r.u8();

        if (keyType === 1) {
            return {keyType, key: r.bytes(8)};
        }

        if (keyType === 2) {
            return {keyType, key: r.u16()};
        }

        throw new CodecError("invalid table key type");
    },
    def: () => ({keyType: 2, key: 0}),
};

export const TblLookupReq = req(Id.TBL_LOOKUP, {table: u8, key: tableKey});
export const TblLookupRsp = rsp(Id.TBL_LOOKUP, {rev: u32, record});
export const PushResult = struct({status: u8, rev: u32});
export const TblPushReq = req(Id.TBL_PUSH, {table: u8, flags: u8, records: listOf(record)});
export const TblPushRsp = rsp(Id.TBL_PUSH, {results: listOf(PushResult)});
export const TblWritebackReq = req(Id.TBL_WRITEBACK, {table: u8, reason: u8, rev: u32, record});
export const TblInvalidateReq = req(Id.TBL_INVALIDATE, {table: u8, key: tableKey});
export const TblSyncReq = req(Id.TBL_SYNC, {hostDbEpoch: u32, lastNcpTableEpoch: u32, hostMaxRev: u32, flags: u8});
export const TblSyncRsp = rsp(Id.TBL_SYNC, {
    ncpTableEpoch: u32,
    hostAckedRev: u32,
    dirty: u16,
    cachedDevices: u16,
    cachedRoutes: u16,
    pagingActive: u8,
});
export const EvtTblEpochChanged = evt(Id.EVT_TBL_EPOCH_CHANGED, {newEpoch: u32, reason: u8});

// BACKUP (9.4, 9.5)
export const RestoreNoteEntry = struct({index: u16, note: u8});
export const BkpExportBeginReq = req(Id.BKP_EXPORT_BEGIN, {flags: u8});
export const BkpExportBeginRsp = rsp(Id.BKP_EXPORT_BEGIN, {txn: u16, recordCount: u32});
export const BkpExportReadReq = req(Id.BKP_EXPORT_READ, {txn: u16, maxBytes: u16});
export const BkpExportReadRsp = rsp(Id.BKP_EXPORT_READ, {more: u8, records: rest});
export const BkpExportEndReq = req(Id.BKP_EXPORT_END, {txn: u16});
export const BkpRestoreBeginReq = req(Id.BKP_RESTORE_BEGIN, {flags: u8, nwkMargin: u32, apsMargin: u32, expectedRecords: u32});
export const BkpRestoreBeginRsp = rsp(Id.BKP_RESTORE_BEGIN, {txn: u16, maxRecordsPerPut: u16});
export const BkpRestorePutReq = req(Id.BKP_RESTORE_PUT, {txn: u16, records: rest});
export const BkpRestorePutRsp = rsp(Id.BKP_RESTORE_PUT, {accepted: u16, notes: listOf(RestoreNoteEntry)});
export const BkpRestoreCommitReq = req(Id.BKP_RESTORE_COMMIT, {txn: u16});
export const BkpRestoreCommitRsp = rsp(Id.BKP_RESTORE_COMMIT, {
    nwkFcStart: u32,
    apsFcStart: u32,
    linkKeysOnNcp: u16,
    linkKeysHostBacked: u16,
    children: u16,
});
export const BkpRestoreAbortReq = req(Id.BKP_RESTORE_ABORT, {txn: u16});

// DIAG (7.8)
export const CounterEntry = struct({id: u16, value: u32});
export const NeighborEntry = struct({ieee, nwk: u16, deviceType: u8, rxOn: u8, relationship: u8, lqi: u8, outgoingCost: u8, age: u8});
export const RouteEntry = struct({dst: u16, nextHop: u16, status: u8, flags: u8});
export const DiagGetCountersReq = req(Id.DIAG_GET_COUNTERS, {groupMask: u8});
export const DiagGetCountersRsp = rsp(Id.DIAG_GET_COUNTERS, {counters: listOf(CounterEntry)});
export const DiagGetNeighborsReq = req(Id.DIAG_GET_NEIGHBORS, {start: u8});
export const DiagGetNeighborsRsp = rsp(Id.DIAG_GET_NEIGHBORS, {total: u8, entries: listOf(NeighborEntry)});
export const DiagGetRoutesReq = req(Id.DIAG_GET_ROUTES, {start: u8});
export const DiagGetRoutesRsp = rsp(Id.DIAG_GET_ROUTES, {total: u8, entries: listOf(RouteEntry)});

// FIRMWARE (7.9) - only the layouts (no host flow in this adapter)
export const FwBeginReq = req(Id.FW_BEGIN, {imageSize: u32, format: u8, sha256, version: u32, flags: u8});

// LOG (7.10)
export const LogConfigReq = req(Id.LOG_CONFIG, {level: u8, moduleMask: u32});
export const EvtLogRecord = evt(Id.EVT_LOG_RECORD, {timeMs: u32, level: u8, module: u8, seq: u16, text: rest});
export const EvtLogDropped = evt(Id.EVT_LOG_DROPPED, {count: u32, firstSeq: u16});

// GREEN POWER (7.11)
export const GpGroupEntry = struct({group: u16, alias: u16});
export const GpSinkConfigReq = req(Id.GP_SINK_CONFIG, {
    mode: u8,
    communicationMode: u8,
    group: u16,
    exitMode: u8,
    windowS: u16,
    securityLevel: u8,
    groupcastRadius: u8,
});
export const GpSinkCommissioningReq = req(Id.GP_SINK_COMMISSIONING, {action: u8, flags: u8, windowS: u16});
export const GpSinkTableReadReq = req(Id.GP_SINK_TABLE_READ, {start: u8});
export const GpSinkTableReadRsp = rsp(Id.GP_SINK_TABLE_READ, {total: u8, records: listOf(record)});
export const GpSinkTablePutReq = req(Id.GP_SINK_TABLE_PUT, {flags: u8, records: listOf(record)});
export const GpSinkRemoveReq = req(Id.GP_SINK_REMOVE, {gpdId, flags: u8});
export const GpPairingConfigurationReq = req(Id.GP_PAIRING_CONFIGURATION, {
    dst: u16,
    actions: u8,
    gpdId,
    deviceId: u8,
    communicationMode: u8,
    flags: u8,
    assignedAlias: u16,
    groupcastRadius: u8,
    securityLevel: u8,
    keyType: u8,
    key: key16,
    frameCounter: u32,
    groups: listOf(GpGroupEntry),
    paired: u8,
    endpoints: listOf(u8),
    appInfo: u8,
    manufacturerId: u16,
    modelId: u16,
    gpdCommands: listOf(u8),
    serverClusters: listOf(u16),
    clientClusters: listOf(u16),
});
export const GpSendPairingReq = req(Id.GP_SEND_PAIRING, {
    dst: u16,
    flags: u8,
    gpdId,
    communicationMode: u8,
    securityLevel: u8,
    keyType: u8,
    sinkIeee: ieee,
    sinkNwk: u16,
    sinkGroup: u16,
    deviceId: u8,
    frameCounter: u32,
    key: key16,
    assignedAlias: u16,
    groupcastRadius: u8,
});
export const GpTranslationUpdateReq = req(Id.GP_TRANSLATION_UPDATE, {dst: u16, action: u8, gpdId, translations: listOf(GpTranslation)});
export const GpTranslationRequestReq = req(Id.GP_TRANSLATION_REQUEST, {dst: u16, startIndex: u8});
export const GpRemoteSinkTableRequestReq = req(Id.GP_REMOTE_SINK_TABLE_REQUEST, {dst: u16, index: u8, gpdId});
export const GpRemoteProxyTableRequestReq = req(Id.GP_REMOTE_PROXY_TABLE_REQUEST, {dst: u16, index: u8, gpdId});
export const GpRemoteRsp = struct({zclTsn: u8});

for (const id of [
    Id.GP_PAIRING_CONFIGURATION,
    Id.GP_SEND_PAIRING,
    Id.GP_TRANSLATION_UPDATE,
    Id.GP_TRANSLATION_REQUEST,
    Id.GP_REMOTE_SINK_TABLE_REQUEST,
    Id.GP_REMOTE_PROXY_TABLE_REQUEST,
]) {
    RESPONSES[id] = GpRemoteRsp;
}

export const EvtGpFrame = evt(Id.EVT_GP_FRAME, {
    origin: u8,
    result: u8,
    gpdId,
    deviceId: u8,
    commandId: u8,
    frameCounter: u32,
    securityLevel: u8,
    keyType: u8,
    flags: u8,
    proxyNwk: u16,
    gppGpdLink: u8,
    rssi: i8,
    lqi: u8,
    payload: lv8,
});
export const EvtGpCommissioning = evt(Id.EVT_GP_COMMISSIONING, {state: u8, windowS: u16, involveProxies: u8, exitReason: u8});
export const EvtGpCommissioned = evt(Id.EVT_GP_COMMISSIONED, {gpdId, deviceId: u8, flags: u8, record});
export const EvtGpCommissioningFailed = evt(Id.EVT_GP_COMMISSIONING_FAILED, {gpdId, reason: u8});
export const EvtGpDecommissioned = evt(Id.EVT_GP_DECOMMISSIONED, {gpdId});
export const EvtGpRemoteStatus = evt(Id.EVT_GP_REMOTE_STATUS, {srcNwk: u16, zclTsn: u8, commandId: u8, zclStatus: u8});
const REMOTE_TABLE = {srcNwk: u16, zclTsn: u8, status: u8, total: u8, startIndex: u8, flags: u8, records: listOf(record)};
export const EvtGpRemoteSinkTable = evt(Id.EVT_GP_REMOTE_SINK_TABLE, REMOTE_TABLE);
export const EvtGpRemoteProxyTable = evt(Id.EVT_GP_REMOTE_PROXY_TABLE, REMOTE_TABLE);
export const EvtGpRemoteTranslationTable = evt(Id.EVT_GP_REMOTE_TRANSLATION_TABLE, REMOTE_TABLE);

// #endregion

// #region Helpers

export function encodeResponse<T>(codec: Codec<T> | undefined, body: T | undefined, status = 0): Buffer {
    const rest = codec !== undefined && body !== undefined ? encodeWith(codec, body) : Buffer.alloc(0);

    return Buffer.concat([Buffer.from([status]), rest]);
}

/** `[status, body]`; `body` is `undefined` when only a status was sent (or for an unknown response layout). */
export function decodeResponse<T>(codec: Codec<T> | undefined, payload: Buffer): [status: number, body: T | undefined] {
    if (payload.length === 0) {
        throw new CodecError("empty response");
    }

    const status = payload[0];

    if (codec === undefined || payload.length === 1) {
        return [status, undefined];
    }

    try {
        return [status, codec.read(new Reader(payload, 1))];
    } catch (error) {
        if (status === 0) {
            throw error;
        }

        return [status, undefined];
    }
}

/** Typed body of a request or event (`undefined` for unknown IDs). */
export function decodeMessage(m: Message): unknown {
    const codec = (m.kind === Kind.REQUEST ? REQUESTS : EVENTS)[m.msgId];

    return codec === undefined ? undefined : decodeWith(codec, m.payload);
}

// #endregion

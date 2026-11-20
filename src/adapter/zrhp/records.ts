/** Records shared by BACKUP, TABLES and GREEN POWER (ZRHP spec 9.3, 7.11). */

import {type Codec, CodecError, encodeWith, i8, ieee, key16, listOf, Reader, rest, type StructOf, struct, u8, u16, u32, Writer} from "./codec";
import {crc32c} from "./crc";

export enum RecordType {
    NODE = 0x01,
    NETWORK = 0x02,
    NETWORK_KEY = 0x03,
    TC_LINK_KEY = 0x04,
    DEVICE = 0x05,
    EZSP_HASHED_TCLK = 0x06,
    SOURCE_ROUTE = 0x08,
    GP_PROXY = 0x09,
    RS_PARAMS = 0x0a,
    GP_SINK = 0x0b,
    GP_TRANSLATION = 0x0c,
    END = 0xff,
    /** Not a wire type: a record of a type this host does not know (kept and re-emitted). */
    UNKNOWN = -1,
}

export const DeviceFlags = {
    IS_CHILD: 0x01,
    LINK: 0x02,
    CHILD_INFO: 0x04,
    NWK_VALID: 0x08,
} as const;

export enum KeyAttrs {
    PROVISIONAL = 0,
    UNVERIFIED = 1,
    VERIFIED = 2,
}

export enum KeyOrigin {
    GLOBAL = 0,
    INSTALL_CODE = 1,
    TC_GENERATED = 2,
    IMPORTED = 3,
    EZSP_HASHED = 4,
}

export enum RestoreNote {
    HOST_BACKED = 1,
    CHILD_DEMOTED = 2,
    IGNORED = 3,
    FLOOR_RAISED = 4,
}

/** `u8 app_id`, then `u32 src_id` (app 0) or `[8] ieee, u8 endpoint` (app 2). */
export interface GpdId {
    appId: number;
    srcId?: number;
    ieee?: Buffer;
    endpoint?: number;
}

export const gpdId: Codec<GpdId> = {
    write: (w, v) => {
        w.u8(v.appId);

        if (v.appId === 0) {
            w.u32(v.srcId ?? 0);
        } else if (v.appId === 2) {
            w.bytes(v.ieee ?? Buffer.alloc(8));
            w.u8(v.endpoint ?? 0);
        } else {
            throw new CodecError(`unsupported GPD application ID ${v.appId}`);
        }
    },
    read: (r) => {
        const appId = r.u8();

        if (appId === 0) {
            return {appId, srcId: r.u32()};
        }

        if (appId === 2) {
            return {appId, ieee: r.bytes(8), endpoint: r.u8()};
        }

        throw new CodecError(`unsupported GPD application ID ${appId}`);
    },
    def: () => ({appId: 0, srcId: 0}),
};

export const NodeRecord = struct({ieee, nwk: u16, logicalType: u8, flags: u8});
export const NetworkRecord = struct({
    panId: u16,
    extPanId: ieee,
    channel: u8,
    channelMask: u32,
    nwkUpdateId: u8,
    nwkManager: u16,
    securityLevel: u8,
    txPower: i8,
});
export const NetworkKeyRecord = struct({key: key16, seq: u8, txCounter: u32, flags: u8});
export const TcLinkKeyRecord = struct({key: key16, tcIeee: ieee, txCounter: u32, flags: u8});
export const EzspHashedTclkRecord = struct({seed: key16});
export const ChildInfo = struct({capability: u8, timeoutExp: u8});
export const LinkBlock = struct({key: key16, keySeq: u8, attrs: u8, origin: u8, txCounter: u32, rxFloor: u32});
export const SourceRouteRecord = struct({dst: u16, relays: listOf(u16)});
export const GpProxyRecord = struct({formatVersion: u8, entries: rest});
export const RsParamsRecord = struct({fcStride: u32, tableEpoch: u32, nwkFcLimit: u32, apsFcLimit: u32, flags: u8});
export const EndRecord = struct({recordCount: u32, crc32c: u32});

export interface DeviceRecordValue {
    ieee: Buffer;
    nwk: number;
    flags: number;
    child?: StructOf<typeof ChildInfo.fields>;
    link?: StructOf<typeof LinkBlock.fields>;
}

/** `DEVICE`: flag bits 1 (link) and 2 (child info) follow `link`/`child`. */
export const DeviceRecord: Codec<DeviceRecordValue> = {
    write: (w, v) => {
        let flags = v.flags & ~(DeviceFlags.LINK | DeviceFlags.CHILD_INFO);

        if (v.child) {
            flags |= DeviceFlags.CHILD_INFO;
        }

        if (v.link) {
            flags |= DeviceFlags.LINK;
        }

        ieee.write(w, v.ieee);
        w.u16(v.nwk);
        w.u8(flags);

        if (v.child) {
            ChildInfo.write(w, v.child);
        }

        if (v.link) {
            LinkBlock.write(w, v.link);
        }
    },
    read: (r) => {
        const out: DeviceRecordValue = {ieee: r.bytes(8), nwk: r.u16(), flags: r.u8()};

        if (out.flags & DeviceFlags.CHILD_INFO) {
            out.child = ChildInfo.read(r);
        }

        if (out.flags & DeviceFlags.LINK) {
            out.link = LinkBlock.read(r);
        }

        return out;
    },
    def: () => ({ieee: Buffer.alloc(8), nwk: 0xffff, flags: 0}),
};

export const GpSinkFlags = {
    MAC_SEQ_CAPABLE: 0x01,
    RX_ON_CAPABLE: 0x02,
    FIXED_LOCATION: 0x04,
    KEY_PRESENT: 0x08,
} as const;

export interface GpSinkRecordValue {
    gpdId: GpdId;
    deviceId: number;
    communicationMode: number;
    group: number;
    assignedAlias: number;
    flags: number;
    securityLevel: number;
    keyType: number;
    key?: Buffer;
    frameCounter: number;
    groupcastRadius: number;
}

/** `GP_SINK`: flag bit 3 (key present) follows `key`. */
export const GpSinkRecord: Codec<GpSinkRecordValue> = {
    write: (w, v) => {
        let flags = v.flags & ~GpSinkFlags.KEY_PRESENT;

        if (v.key) {
            flags |= GpSinkFlags.KEY_PRESENT;
        }

        gpdId.write(w, v.gpdId);
        w.u8(v.deviceId);
        w.u8(v.communicationMode);
        w.u16(v.group);
        w.u16(v.assignedAlias);
        w.u8(flags);
        w.u8(v.securityLevel);
        w.u8(v.keyType);

        if (v.key) {
            key16.write(w, v.key);
        }

        w.u32(v.frameCounter);
        w.u8(v.groupcastRadius);
    },
    read: (r) => {
        const out: GpSinkRecordValue = {
            gpdId: gpdId.read(r),
            deviceId: r.u8(),
            communicationMode: r.u8(),
            group: r.u16(),
            assignedAlias: r.u16(),
            flags: r.u8(),
            securityLevel: r.u8(),
            keyType: r.u8(),
            frameCounter: 0,
            groupcastRadius: 0,
        };

        if (out.flags & GpSinkFlags.KEY_PRESENT) {
            out.key = r.bytes(16);
        }

        out.frameCounter = r.u32();
        out.groupcastRadius = r.u8();

        return out;
    },
    def: () => ({
        gpdId: {appId: 0, srcId: 0},
        deviceId: 0,
        communicationMode: 2,
        group: 0xffff,
        assignedAlias: 0xffff,
        flags: 0,
        securityLevel: 0,
        keyType: 0,
        frameCounter: 0,
        groupcastRadius: 0,
    }),
};

export interface GpTranslationValue {
    gpdCommand: number;
    endpoint: number;
    profile: number;
    cluster: number;
    zclCommand: number;
    /** 0x00-0xFD: payload bytes follow; 0xFE derived; 0xFF GPD payload copied. */
    payloadLen: number;
    payload: Buffer;
}

export const TRANSLATION_DERIVED = 0xfe;

/** One GPD command -> ZCL command translation (7.11). */
export const GpTranslation: Codec<GpTranslationValue> = {
    write: (w, v) => {
        const fixedLen = v.payloadLen < TRANSLATION_DERIVED;

        if ((fixedLen && v.payloadLen !== v.payload.length) || (!fixedLen && v.payload.length > 0)) {
            throw new CodecError("translation payload length mismatch");
        }

        w.u8(v.gpdCommand);
        w.u8(v.endpoint);
        w.u16(v.profile);
        w.u16(v.cluster);
        w.u8(v.zclCommand);
        w.u8(v.payloadLen);
        w.bytes(v.payload);
    },
    read: (r) => {
        const out: GpTranslationValue = {
            gpdCommand: r.u8(),
            endpoint: r.u8(),
            profile: r.u16(),
            cluster: r.u16(),
            zclCommand: r.u8(),
            payloadLen: r.u8(),
            payload: Buffer.alloc(0),
        };

        if (out.payloadLen < TRANSLATION_DERIVED) {
            out.payload = r.bytes(out.payloadLen);
        }

        return out;
    },
    def: () => ({gpdCommand: 0, endpoint: 0, profile: 0x0104, cluster: 0, zclCommand: 0, payloadLen: 0, payload: Buffer.alloc(0)}),
};

export function translation(v: Partial<GpTranslationValue>): GpTranslationValue {
    const payload = v.payload ?? Buffer.alloc(0);

    return {...GpTranslation.def(), payloadLen: payload.length, ...v, payload};
}

export const GpTranslationRecord = struct({gpdId, translation: GpTranslation});

export type ZrhpRecord =
    | {type: RecordType.NODE; value: StructOf<typeof NodeRecord.fields>}
    | {type: RecordType.NETWORK; value: StructOf<typeof NetworkRecord.fields>}
    | {type: RecordType.NETWORK_KEY; value: StructOf<typeof NetworkKeyRecord.fields>}
    | {type: RecordType.TC_LINK_KEY; value: StructOf<typeof TcLinkKeyRecord.fields>}
    | {type: RecordType.DEVICE; value: DeviceRecordValue}
    | {type: RecordType.EZSP_HASHED_TCLK; value: StructOf<typeof EzspHashedTclkRecord.fields>}
    | {type: RecordType.SOURCE_ROUTE; value: StructOf<typeof SourceRouteRecord.fields>}
    | {type: RecordType.GP_PROXY; value: StructOf<typeof GpProxyRecord.fields>}
    | {type: RecordType.RS_PARAMS; value: StructOf<typeof RsParamsRecord.fields>}
    | {type: RecordType.GP_SINK; value: GpSinkRecordValue}
    | {type: RecordType.GP_TRANSLATION; value: StructOf<typeof GpTranslationRecord.fields>}
    | {type: RecordType.END; value: StructOf<typeof EndRecord.fields>}
    | {type: RecordType.UNKNOWN; rtype: number; raw: Buffer};

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous codec table
const RECORD_CODECS: Record<number, Codec<any>> = {
    [RecordType.NODE]: NodeRecord,
    [RecordType.NETWORK]: NetworkRecord,
    [RecordType.NETWORK_KEY]: NetworkKeyRecord,
    [RecordType.TC_LINK_KEY]: TcLinkKeyRecord,
    [RecordType.DEVICE]: DeviceRecord,
    [RecordType.EZSP_HASHED_TCLK]: EzspHashedTclkRecord,
    [RecordType.SOURCE_ROUTE]: SourceRouteRecord,
    [RecordType.GP_PROXY]: GpProxyRecord,
    [RecordType.RS_PARAMS]: RsParamsRecord,
    [RecordType.GP_SINK]: GpSinkRecord,
    [RecordType.GP_TRANSLATION]: GpTranslationRecord,
    [RecordType.END]: EndRecord,
};

/** The value bytes of a record (no TLV header). */
export function encodeRecordValue(rec: ZrhpRecord): Buffer {
    if (rec.type === RecordType.UNKNOWN) {
        return rec.raw;
    }

    return encodeWith(RECORD_CODECS[rec.type], rec.value);
}

/** One TLV: `u8 type, u16 len, value`. */
export function encodeRecord(rec: ZrhpRecord): Buffer {
    const body = encodeRecordValue(rec);

    if (body.length > 0xffff) {
        throw new CodecError("record too long");
    }

    const head = Buffer.alloc(3);
    head[0] = rec.type === RecordType.UNKNOWN ? rec.rtype : rec.type;
    head.writeUInt16LE(body.length, 1);

    return Buffer.concat([head, body]);
}

export function decodeRecordValue(rtype: number, value: Buffer): ZrhpRecord {
    const codec = RECORD_CODECS[rtype];

    if (codec === undefined) {
        return {type: RecordType.UNKNOWN, rtype, raw: Buffer.from(value)};
    }

    return {type: rtype, value: codec.read(new Reader(value))} as ZrhpRecord;
}

/** A TLV record as a field. */
export const record: Codec<ZrhpRecord> = {
    write: (w, v) => w.bytes(encodeRecord(v)),
    read: (r) => {
        const rtype = r.u8();
        const len = r.u16();

        return decodeRecordValue(rtype, r.bytes(len));
    },
    def: () => ({type: RecordType.UNKNOWN, rtype: 0, raw: Buffer.alloc(0)}),
};

export function decodeRecords(stream: Buffer): ZrhpRecord[] {
    const r = new Reader(stream);
    const out: ZrhpRecord[] = [];

    while (r.remaining > 0) {
        out.push(record.read(r));
    }

    return out;
}

export function encodeRecords(recs: ZrhpRecord[]): Buffer {
    const w = new Writer();

    for (const rec of recs) {
        record.write(w, rec);
    }

    return w.toBuffer();
}

/** The `END` record over already-encoded TLVs. */
export function endRecord(tlvs: Buffer[]): ZrhpRecord {
    return {type: RecordType.END, value: {recordCount: tlvs.length, crc32c: crc32c(Buffer.concat(tlvs))}};
}

/** Check the trailing `END` record of a stream (count and CRC-32C). */
export function checkEnd(recs: ZrhpRecord[]): void {
    const end = recs.at(-1);

    if (end?.type !== RecordType.END) {
        throw new Error("record stream does not end with END");
    }

    const expect = endRecord(recs.slice(0, -1).map(encodeRecord));

    if (expect.type === RecordType.END && (expect.value.recordCount !== end.value.recordCount || expect.value.crc32c !== end.value.crc32c)) {
        throw new Error("END record count or CRC mismatch");
    }
}

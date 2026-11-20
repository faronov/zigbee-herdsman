/**
 * Byte-exact tests against the shared ZRHP vectors (spec 14.1).
 *
 * The JSON files in `vectors/` are copies of `zigbee-rs/docs/book/src/advanced/host-protocol-vectors`; CI compares them with
 * the zigbee-rs checkout (`.github/workflows/zrhp.yml`).
 */

import {describe, expect, it} from "vitest";
import {BadFrame, CobsAccumulator, cobsDecode, cobsEncode, MAX_ENCODED_FRAME} from "../../../src/adapter/zrhp/cobs";
import {type Codec, encodeWith, Reader} from "../../../src/adapter/zrhp/codec";
import {AddrMode, FC_STRIDE, Kind, type LinkEndpoint} from "../../../src/adapter/zrhp/consts";
import {crc32c} from "../../../src/adapter/zrhp/crc";
import {aesMmo, hmacMmo} from "../../../src/adapter/zrhp/crypto";
import {
    CTRL_POLL,
    CTRL_RETX,
    encodeAckBody,
    encodeFrame,
    encodeRejectBody,
    encodeResetBody,
    encodeWire,
    type FrameType,
    header,
    parseAckBody,
    parseFrame,
    parseRejectBody,
    parseResetBody,
    resetBody,
    sessionEpoch,
} from "../../../src/adapter/zrhp/frame";
import * as M from "../../../src/adapter/zrhp/messages";
import {ieeeWire, ocbToRecords, recordsToOcb, restoreMargins} from "../../../src/adapter/zrhp/ocb";
import {decodeRecords, encodeRecord, type GpSinkRecordValue, RecordType, translation, type ZrhpRecord} from "../../../src/adapter/zrhp/records";
import {applyRestore, type Json, loadVector} from "./vectorUtils";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous codecs
type AnyCodec = Codec<any>;

const hex = (s: string): Buffer => Buffer.from(s, "hex");

describe("ZRHP vectors: crc32c / cobs / epoch", () => {
    it("crc32c.json", () => {
        for (const v of loadVector("crc32c.json").vectors) {
            const raw = v.input_ascii !== undefined ? Buffer.from(v.input_ascii) : hex(v.input_hex);
            expect(crc32c(raw)).toStrictEqual(Number.parseInt(v.crc32c, 16));
        }
    });

    it("cobs.json encode and decode", () => {
        const data = loadVector("cobs.json");

        for (const v of data.vectors) {
            const raw = hex(v.raw_hex);
            const enc = hex(v.encoded_hex);
            expect(raw.length).toStrictEqual(v.raw_len);
            expect(enc.length).toStrictEqual(v.encoded_len);
            expect(cobsEncode(raw).toString("hex")).toStrictEqual(v.encoded_hex);
            expect(cobsDecode(enc).toString("hex")).toStrictEqual(v.raw_hex);
            const acc = new CobsAccumulator(1024);
            const results = [...enc, 0].map((b) => acc.push(b));
            expect((results.at(-1) as Buffer).toString("hex")).toStrictEqual(v.raw_hex);
        }

        for (const v of data.decode_only) {
            expect(cobsDecode(hex(v.encoded_hex)).toString("hex")).toStrictEqual(v.raw_hex);
        }
    });

    it("cobs accumulator rejects malformed and oversized frames", () => {
        expect(() => cobsDecode(Buffer.alloc(0))).toThrow("empty frame");
        expect(() => cobsDecode(Buffer.from([0x05, 0x01]))).toThrow("past the end");
        expect(() => cobsDecode(Buffer.from([0x03, 0x01, 0x00]))).toThrow("zero byte");
        expect(() => cobsDecode(Buffer.from([0x00]))).toThrow("zero byte");
        const acc = new CobsAccumulator(4);
        expect([1, 1, 1, 1, 1].map((b) => acc.push(b)).at(-1)).toStrictEqual(BadFrame.TooLong);
        expect(acc.push(7)).toBeUndefined();
        expect(acc.push(0)).toBeUndefined(); // the discarded frame ends here
        expect([5, 1, 0].map((b) => acc.push(b)).at(-1)).toStrictEqual(BadFrame.Cobs);
        expect(acc.lineError()).toStrictEqual(BadFrame.LineError);
        expect(acc.push(2)).toBeUndefined();
        expect(acc.push(0)).toBeUndefined();
        expect(acc.push(0)).toBeUndefined(); // empty frame
    });

    it("session epoch", () => {
        const s = loadVector("link_frames.json").session;
        expect(sessionEpoch(Number.parseInt(s.host_cookie, 16), Number.parseInt(s.ncp_cookie, 16))).toStrictEqual(s.epoch);
    });
});

function typedPayload(name: string): Buffer | undefined {
    const credits: [number, number][] = [
        [1, 4],
        [2, 8],
        [3, 4],
        [4, 4],
        [5, 2],
    ];

    switch (name) {
        case "reset_req_host":
            return encodeResetBody(resetBody({cookie: 0x1a2b3c4d, peerCookie: 0, role: 0, rxWindow: 32, reason: 4, credits}));
        case "reset_ack_ncp":
            return encodeResetBody(
                resetBody({
                    cookie: 0xc0ffee01,
                    peerCookie: 0x1a2b3c4d,
                    role: 1,
                    rxWindow: 16,
                    reason: 0,
                    credits: [
                        [1, 4],
                        [2, 8],
                        [3, 4],
                        [4, 2],
                        [5, 0],
                    ],
                }),
            );
        case "ack_plain":
        case "keepalive_poll":
            return encodeAckBody({sack: 0, nbad: 0, credits: []});
        case "nak_gap":
            return encodeAckBody({sack: 0b11, nbad: 0, credits: []});
        case "nak_crc_error":
            return encodeAckBody({sack: 0, nbad: 1, credits: []});
        case "ack_with_credits":
            return encodeAckBody({
                sack: 0,
                nbad: 0,
                credits: [
                    [2, 17],
                    [4, 6],
                ],
            });
        case "reject_no_credit":
            return encodeRejectBody({seq: 7, endpoint: 4, epSeq: 6, reason: 1});
        case "data_negotiate":
            return M.encodeMessage({
                kind: Kind.REQUEST,
                msgId: M.Id.SYS_NEGOTIATE,
                tid: 1,
                payload: M.SysNegotiateReq.encode({majorMin: 1, majorMax: 1, hostCaps: 0n, name: Buffer.from("zigpy-zrs/0.1")}),
            });
        case "data_batch_two_messages":
        case "data_retransmit_poll":
            return Buffer.concat([
                M.encodeMessage({kind: Kind.REQUEST, msgId: M.Id.SYS_ECHO, tid: 2, payload: M.SysEchoReq.encode({data: Buffer.from("ping")})}),
                M.encodeMessage({kind: Kind.REQUEST, msgId: M.Id.SYS_GET_STATUS, tid: 3, payload: Buffer.alloc(0)}),
            ]);
        default:
            return undefined;
    }
}

describe("ZRHP vectors: link_frames.json", () => {
    const data = loadVector("link_frames.json");

    it.each(data.vectors.map((v: Json) => [v.name, v]))("%s", (name, v: Json) => {
        const payload = hex(v.payload_hex);
        const typed = typedPayload(name as string);

        if (typed !== undefined) {
            expect(typed.toString("hex")).toStrictEqual(v.payload_hex);
        }

        const f = v.fields;
        const flags = f.flags ?? 0;
        const h = header(v.type as FrameType, {
            epoch: f.epoch ?? 0,
            endpoint: f.endpoint ?? 0,
            seq: f.seq ?? 0,
            ack: f.ack ?? 0,
            epSeq: f.ep_seq ?? 0,
            poll: (flags & CTRL_POLL) !== 0,
            retx: (flags & CTRL_RETX) !== 0,
        });
        const decoded = encodeFrame(h, payload);
        expect(decoded.toString("hex")).toStrictEqual(v.decoded_hex);
        expect(decoded.readUInt32LE(decoded.length - 4)).toStrictEqual(Number.parseInt(v.crc32c, 16));
        const wire = encodeWire(h, payload);
        expect(wire.toString("hex")).toStrictEqual(v.wire_hex);
        expect(wire.length).toBeLessThanOrEqual(MAX_ENCODED_FRAME + 1);
        const acc = new CobsAccumulator();
        const out = [...wire].map((b) => acc.push(b));
        const parsed = parseFrame(out.at(-1) as Buffer);
        expect(parsed.header).toStrictEqual(h);
        expect(parsed.payload.toString("hex")).toStrictEqual(v.payload_hex);

        if (v.type === 3 || v.type === 4) {
            expect(encodeResetBody(parseResetBody(payload)).toString("hex")).toStrictEqual(v.payload_hex);
        } else if (v.type === 1 || v.type === 2) {
            expect(encodeAckBody(parseAckBody(payload)).toString("hex")).toStrictEqual(v.payload_hex);
        } else if (v.type === 5) {
            expect(encodeRejectBody(parseRejectBody(payload)).toString("hex")).toStrictEqual(v.payload_hex);
        } else if (name !== "data_max_payload") {
            expect(Buffer.concat(M.parseBatch(payload).map(M.encodeMessage)).toString("hex")).toStrictEqual(v.payload_hex);
        }
    });

    it("rejects malformed frames in validation order", () => {
        const good = encodeFrame(header(0), Buffer.from([1, 2]));
        expect(() => parseFrame(good.subarray(0, 5))).toThrow("length");
        expect(() => parseFrame(Buffer.concat([good, Buffer.from([0])]))).toThrow("length");
        const badCrc = Buffer.from(good);
        badCrc[8] ^= 1;
        expect(() => parseFrame(badCrc)).toThrow("crc");
        const v2 = encodeFrame(header(0), Buffer.alloc(0));
        v2[0] = 0x80;
        v2.writeUInt32LE(crc32c(v2.subarray(0, 8)), 8);
        expect(() => parseFrame(v2)).toThrow("version");
        const t9 = encodeFrame(header(0), Buffer.alloc(0));
        t9[0] = 0x49;
        t9.writeUInt32LE(crc32c(t9.subarray(0, 8)), 8);
        expect(() => parseFrame(t9)).toThrow("type");
        expect(() => parseResetBody(Buffer.alloc(3))).toThrow("truncated");
        expect(() => parseAckBody(Buffer.alloc(3))).toThrow("truncated");
        expect(() => parseAckBody(Buffer.from([0, 0, 0, 0, 0, 2, 1]))).toThrow("truncated");
        expect(() => parseRejectBody(Buffer.alloc(3))).toThrow("truncated");
        expect(() => encodeFrame(header(0), Buffer.alloc(641))).toThrow("too long");
    });
});

const GPD_KEY = hex("c0c1c2c3c4c5c6c7c8c9cacbcccdcecf");
const SINK_REC: GpSinkRecordValue = {
    gpdId: {appId: 0, srcId: 0x293c9879},
    deviceId: 0x02,
    communicationMode: 2,
    group: 0x0b84,
    assignedAlias: 0xffff,
    flags: 0x09,
    securityLevel: 3,
    keyType: 4,
    key: GPD_KEY,
    frameCounter: 4448,
    groupcastRadius: 0,
};
const TOGGLE_OFF = translation({gpdCommand: 0x22, endpoint: 1, cluster: 0x0006, zclCommand: 0x00});
const STEP_DERIVED = translation({gpdCommand: 0x32, endpoint: 1, cluster: 0x0008, zclCommand: 0x06, payloadLen: 0xfe});
const MOVE_TO_LEVEL = translation({gpdCommand: 0x21, endpoint: 2, cluster: 0x0008, zclCommand: 0x04, payload: hex("800a00")});
const DEVICE_HEX = "0526000c0b0afeff142e84214f0aa0a1a2a3a4a5a6a7a8a9aaabacadaeaf000203c836000003000000";
const deviceRec = (): ZrhpRecord => decodeRecords(hex(DEVICE_HEX))[0];

/** `[codec, value]` each message vector must serialize to. */
function built(name: string): [AnyCodec, unknown] | undefined {
    switch (name) {
        case "sys_negotiate_req":
            return [M.SysNegotiateReq, M.SysNegotiateReq.make({majorMin: 1, majorMax: 1, hostCaps: 0n, name: Buffer.from("zigpy-zrs/0.1")})];
        case "sys_negotiate_rsp": {
            const caps: [number, number][] = [
                [1, 16],
                [2, 64],
                [3, 256],
                [4, 512],
                [5, 128],
                [6, 100],
                [7, 1024],
                [8, 8],
                [13, 16],
                [14, 8],
                [15, 16],
                [16, 8],
                [17, 8],
                [18, 256],
            ];
            return [
                M.SysNegotiateRsp,
                {
                    major: 1,
                    minor: 0,
                    ncpCaps: 0x1787fbn,
                    capacities: caps.map(([id, value]) => ({id, value})),
                    fw: Buffer.from("0.1.0"),
                    buildId: hex("0123456789abcdef"),
                    chip: 1,
                },
            ];
        }
        case "evt_ncp_ready":
            return [
                M.EvtNcpReady,
                {
                    ncpCookie: 0xc0ffee01,
                    resetReason: 1,
                    networkState: 2,
                    tableEpoch: 7,
                    nwkFcLimit: 2011024,
                    apsFcLimit: 14024,
                    dirtyWritebacks: 0,
                    droppedIndications: 0,
                },
            ];
        case "aps_data_request_unicast":
            return [
                M.ApsDataRequest,
                M.apsDataRequest({
                    dstMode: AddrMode.NWK,
                    dst: 0x1a2b,
                    dstEp: 1,
                    srcEp: 1,
                    profile: 0x0104,
                    cluster: 0,
                    txOptions: 1,
                    priority: 1,
                    asdu: hex("002a0004000500"),
                }),
            ];
        case "aps_data_request_source_routed":
            return [
                M.ApsDataRequest,
                M.apsDataRequest({
                    dst: 0x8f3e,
                    dstEp: 1,
                    srcEp: 1,
                    profile: 0x0104,
                    cluster: 0x0006,
                    txOptions: 0x41,
                    relays: [0x1a2b, 0x3c4d],
                    asdu: hex("012b02"),
                }),
            ];
        case "evt_aps_data_confirm":
            return [M.EvtApsDataConfirm, {reqTid: 0x0102, status: 0, zbStatus: 0, apsCounter: 0x37, dstNwk: 0x1a2b, flags: 1, elapsedMs: 23}];
        case "evt_aps_data_indication":
            return [
                M.EvtApsDataIndication,
                {
                    dstMode: 0x02,
                    dst: 0,
                    dstEp: 1,
                    srcNwk: 0x8f3e,
                    srcIeee: ieeeWire("00158d0004c5d6e7"),
                    srcEp: 1,
                    profile: 0x0104,
                    cluster: 0x0402,
                    flags: 0x06,
                    lqi: 0xb4,
                    rssi: -61,
                    lastHopNwk: 0x1a2b,
                    apsCounter: 0x5c,
                    keySource: 0,
                    rxTimeMs: 123456,
                    asdu: hex("18050a0000293409"),
                },
            ];
        case "nwk_permit_join":
            return [M.NwkPermitJoinReq, {durationS: 254, target: 0xfffc, flags: 1}];
        case "evt_device_joined":
            return [
                M.EvtDeviceJoined,
                {nwk: 0x4f21, ieee: ieeeWire("842e14fffe0a0b0c"), parentNwk: 0x1a2b, joinType: 0, capability: 0x80, decision: 0},
            ];
        case "evt_route_record":
            return [M.EvtRouteRecord, {srcNwk: 0x8f3e, srcIeee: ieeeWire("00158d0004c5d6e7"), relays: [0x3c4d, 0x1a2b]}];
        case "sec_add_install_code":
            return [M.SecAddInstallCodeReq, {ieee: ieeeWire("842e14fffe0a0b0c"), code: hex("88776655443322111122334455667788D490")}];
        case "sec_add_install_code_rsp":
            return [M.SecAddInstallCodeRsp, {derivedKey: hex("fa8081caaa41d5ade9b5658799268b88")}];
        case "evt_fc_checkpoint":
            return [M.EvtFcCheckpoint, {domain: 1, keySeq: 1, durableLimit: 2012048, generation: 7}];
        case "tbl_lookup_req":
            return [M.TblLookupReq, {table: 0x05, key: {keyType: 2, key: 0x4f21}}];
        case "tbl_lookup_rsp":
            return [M.TblLookupRsp, {rev: 41, record: deviceRec()}];
        case "tbl_writeback_evict":
            return [M.TblWritebackReq, {table: 0x05, reason: 3, rev: 57, record: deviceRec()}];
        case "sec_lock_key_export":
            return [M.SecLockKeyExportReq, {confirm: 0x4b434f4c}];
        case "sys_set_uart":
            return [M.SysSetUartReq, {baud: 921600, flow: 0, applyDelayMs: 50}];
        case "evt_log_record":
            return [M.EvtLogRecord, {timeMs: 5321, level: 3, module: 2, seq: 17, text: Buffer.from("zrhp: session up, window 16")}];
        case "gp_sink_config_zigpy":
            return [
                M.GpSinkConfigReq,
                {mode: 1, communicationMode: 2, group: 0x0b84, exitMode: 5, windowS: 180, securityLevel: 0, groupcastRadius: 0},
            ];
        case "gp_sink_commissioning_enter":
            return [M.GpSinkCommissioningReq, {action: 1, flags: 1, windowS: 254}];
        case "evt_gp_commissioned":
            return [
                M.EvtGpCommissioned,
                {gpdId: {appId: 0, srcId: 0x293c9879}, deviceId: 0x02, flags: 0x02, record: {type: RecordType.GP_SINK, value: SINK_REC}},
            ];
        case "evt_gp_frame_toggle":
            return [
                M.EvtGpFrame,
                {
                    origin: 1,
                    result: 1,
                    gpdId: {appId: 0, srcId: 0x293c9879},
                    deviceId: 0x02,
                    commandId: 0x22,
                    frameCounter: 4449,
                    securityLevel: 3,
                    keyType: 4,
                    flags: 0x02,
                    proxyNwk: 0xffff,
                    gppGpdLink: 0xff,
                    rssi: -48,
                    lqi: 220,
                    payload: Buffer.alloc(0),
                },
            ];
        case "gp_pairing_configuration":
            return [
                M.GpPairingConfigurationReq,
                M.GpPairingConfigurationReq.make({
                    dst: 0x7c87,
                    actions: 0x0a,
                    gpdId: {appId: 0, srcId: 0x7a6b9879},
                    deviceId: 0x02,
                    communicationMode: 1,
                    flags: 0x0d,
                    securityLevel: 3,
                    keyType: 4,
                    key: GPD_KEY,
                    frameCounter: 10,
                    paired: 0xfe,
                }),
            ];
        case "gp_remote_rsp":
            return [M.GpRemoteRsp, {zclTsn: 5}];
        case "gp_translation_update":
            return [
                M.GpTranslationUpdateReq,
                {dst: 0x7c87, action: 0, gpdId: {appId: 0, srcId: 0x7a6b9879}, translations: [TOGGLE_OFF, STEP_DERIVED, MOVE_TO_LEVEL]},
            ];
        case "gp_send_pairing":
            return [
                M.GpSendPairingReq,
                M.GpSendPairingReq.make({
                    dst: 0xfffd,
                    flags: 0x59,
                    gpdId: {appId: 0, srcId: 0x7a6b9879},
                    communicationMode: 3,
                    securityLevel: 3,
                    keyType: 4,
                    sinkIeee: ieeeWire("0102030405060708"),
                    sinkNwk: 0x7c87,
                    sinkGroup: 0,
                    deviceId: 0x02,
                    frameCounter: 10,
                    key: GPD_KEY,
                }),
            ];
        case "gp_translation_request":
            return [M.GpTranslationRequestReq, {dst: 0x7c87, startIndex: 0}];
        case "gp_remote_sink_table_request":
            return [M.GpRemoteSinkTableRequestReq, {dst: 0x7c87, index: 0xff, gpdId: {appId: 0, srcId: 0x7a6b9879}}];
        case "evt_gp_remote_status":
            return [M.EvtGpRemoteStatus, {srcNwk: 0x7c87, zclTsn: 5, commandId: 0x09, zclStatus: 0}];
        case "evt_gp_remote_translation_table":
            return [
                M.EvtGpRemoteTranslationTable,
                {
                    srcNwk: 0x7c87,
                    zclTsn: 6,
                    status: 0,
                    total: 2,
                    startIndex: 0,
                    flags: 0,
                    records: [
                        {type: RecordType.GP_TRANSLATION, value: {gpdId: {appId: 0, srcId: 0x7a6b9879}, translation: TOGGLE_OFF}},
                        {type: RecordType.GP_TRANSLATION, value: {gpdId: {appId: 0, srcId: 0x7a6b9879}, translation: STEP_DERIVED}},
                    ],
                },
            ];
        default:
            return undefined;
    }
}

const STATUS_ONLY: Record<string, number> = {aps_data_request_rsp_accepted: 0, aps_data_request_rsp_busy: 2, sec_lock_key_export_rsp: 0};

describe("ZRHP vectors: messages.json", () => {
    const vectors = loadVector("messages.json");

    it("has every vector", () => {
        expect(vectors.length).toStrictEqual(34);
    });

    it.each(vectors.map((v: Json) => [v.name, v]))("%s", (name, v: Json) => {
        const payload = hex(v.payload_hex);
        const kind = v.kind as Kind;
        const msgId = Number.parseInt(v.msg_id, 16);
        const msg: M.Message = {kind, msgId, tid: v.tid, payload, retry: false};
        expect(M.encodeMessage(msg).toString("hex")).toStrictEqual(v.message_hex);
        expect(M.homeEndpoint(msgId)).toStrictEqual(v.endpoint as LinkEndpoint);
        expect(M.parseBatch(M.encodeMessage(msg))).toStrictEqual([msg]);

        if (STATUS_ONLY[name as string] !== undefined) {
            expect(payload).toStrictEqual(Buffer.from([STATUS_ONLY[name as string]]));
            expect(M.decodeResponse(M.RESPONSES[msgId], payload)).toStrictEqual([STATUS_ONLY[name as string], undefined]);
            return;
        }

        const b = built(name as string);
        expect(b).toBeDefined();
        const [codec, value] = b as [AnyCodec, unknown];

        if (kind === Kind.RESPONSE) {
            expect(M.encodeResponse(codec, value).toString("hex")).toStrictEqual(v.payload_hex);
            const [status, body] = M.decodeResponse(M.RESPONSES[msgId], payload);
            expect(status).toStrictEqual(0);
            expect(body).toStrictEqual(value);
        } else {
            expect(encodeWith(codec, value).toString("hex")).toStrictEqual(v.payload_hex);
            expect(M.decodeMessage(msg)).toStrictEqual(value);
        }

        if (v.fields.record_hex !== undefined) {
            expect(encodeRecord({type: RecordType.GP_SINK, value: SINK_REC}).toString("hex")).toStrictEqual(v.fields.record_hex);
        }

        for (const recHex of v.fields.records_hex ?? []) {
            const [rec] = decodeRecords(hex(recHex));
            expect(encodeRecord(rec).toString("hex")).toStrictEqual(recHex);
        }
    });

    it("parseBatch rejects malformed batches", () => {
        expect(() => M.parseBatch(Buffer.alloc(0))).toThrow("empty");
        expect(() => M.parseBatch(Buffer.alloc(3))).toThrow("truncated header");
        expect(() => M.parseBatch(hex("c0010001000000"))).toThrow("reserved kind");
        expect(() => M.parseBatch(hex("01010001000000"))).toThrow("reserved flags");
        expect(() => M.parseBatch(hex("00010001000500"))).toThrow("truncated message");
        expect(M.parseBatch(hex("20010001000000"))[0].retry).toStrictEqual(true);
    });

    it("decodes responses with only a status or an error status", () => {
        expect(() => M.decodeResponse(undefined, Buffer.alloc(0))).toThrow("empty response");
        expect(M.decodeResponse(M.NwkGetInfoRsp, Buffer.from([0x0b]))).toStrictEqual([0x0b, undefined]);
        expect(M.decodeResponse(M.NwkGetInfoRsp, Buffer.from([0x0b, 1]))).toStrictEqual([0x0b, undefined]);
        expect(() => M.decodeResponse(M.NwkGetInfoRsp, Buffer.from([0, 1]))).toThrow("truncated");
        expect(M.decodeMessage({kind: Kind.EVENT, msgId: 0x0fff, tid: 1, payload: Buffer.alloc(0)})).toBeUndefined();
        expect(M.nameOf(M.Id.NWK_INIT)).toStrictEqual("NWK_INIT");
        expect(M.nameOf(0x0fff)).toStrictEqual("0x0fff");
    });

    it("APS_DATA_REQUEST with IEEE, group and alias addressing round-trips", () => {
        for (const v of [
            M.apsDataRequest({dstMode: AddrMode.IEEE, dst: ieeeWire("00158d0004c5d6e7"), asdu: hex("0102")}),
            M.apsDataRequest({dstMode: AddrMode.GROUP, dst: 0x1234, nonMemberRadius: 3}),
            M.apsDataRequest({dstMode: AddrMode.BROADCAST, dst: 0xfffd, srcEp: 242, dstEp: 242, alias: [0x9879, 7]}),
        ]) {
            const b = encodeWith(M.ApsDataRequest, v);
            const back = M.decodeMessage({kind: Kind.REQUEST, msgId: M.Id.APS_DATA_REQUEST, tid: 1, payload: b}) as M.ApsDataRequestValue;
            expect(back.dst).toStrictEqual(v.dst);
            expect(back.alias).toStrictEqual(v.alias);
            expect(back.asdu).toStrictEqual(v.asdu);
        }

        expect(() => encodeWith(M.ApsDataRequest, M.apsDataRequest({dstMode: 7 as AddrMode}))).toThrow("invalid dst_mode");
        expect(() => M.ApsDataRequest.read(new Reader(Buffer.from([7])))).toThrow("invalid dst_mode");
    });
});

describe("ZRHP vectors: crypto", () => {
    it("install-code key derivation", () => {
        const v = loadVector("messages.json").find((x: Json) => x.name === "sec_add_install_code_rsp");
        expect(aesMmo(hex("88776655443322111122334455667788D490")).toString("hex")).toStrictEqual(v.fields.derived_key);
    });

    it("ezsp_hashed_tclk.json candidates", () => {
        for (const v of loadVector("ezsp_hashed_tclk.json").vectors) {
            const seed = hex(v.hashed_tclk);
            expect(hmacMmo(seed, ieeeWire(v.ieee)).toString("hex")).toStrictEqual(v.candidate_eui64_on_air_order);
            expect(hmacMmo(seed, hex(v.ieee)).toString("hex")).toStrictEqual(v.candidate_eui64_big_endian);
        }
    });
});

describe("ZRHP vectors: OCB", () => {
    const rt = loadVector("ocb_roundtrip.json");
    const z2m = loadVector("ocb_z2m_import.json");

    it("ocb_roundtrip.json restore records", () => {
        const recs = ocbToRecords(rt.input_ocb);
        expect(recs.map((r) => encodeRecord(r).toString("hex"))).toStrictEqual(rt.restore.records.map((r: Json) => r.hex));
    });

    it("ocb_roundtrip.json restore messages", () => {
        const recs = ocbToRecords(rt.input_ocb);
        const r = rt.restore;
        const msgs = r.messages;
        const begin = M.BkpRestoreBeginReq.encode({flags: 0x01, nwkMargin: r.nwk_margin, apsMargin: r.aps_margin, expectedRecords: recs.length});
        expect(M.encodeMessage({kind: Kind.REQUEST, msgId: M.Id.BKP_RESTORE_BEGIN, tid: 0x0201, payload: begin}).toString("hex")).toStrictEqual(
            msgs.begin,
        );
        const put = M.BkpRestorePutReq.encode({txn: 1, records: Buffer.concat(recs.map(encodeRecord))});
        expect(M.encodeMessage({kind: Kind.REQUEST, msgId: M.Id.BKP_RESTORE_PUT, tid: 0x0202, payload: put}).toString("hex")).toStrictEqual(msgs.put);
        const commit = M.BkpRestoreCommitReq.encode({txn: 1});
        expect(M.encodeMessage({kind: Kind.REQUEST, msgId: M.Id.BKP_RESTORE_COMMIT, tid: 0x0203, payload: commit}).toString("hex")).toStrictEqual(
            msgs.commit,
        );

        for (const [key, codec] of [
            ["begin_rsp", M.BkpRestoreBeginRsp],
            ["put_rsp", M.BkpRestorePutRsp],
            ["commit_rsp", M.BkpRestoreCommitRsp],
        ] as const) {
            const [msg] = M.parseBatch(hex(msgs[key]));
            const [status, body] = M.decodeResponse(codec as AnyCodec, msg.payload);
            expect(status).toStrictEqual(0);
            expect(M.encodeResponse(codec as AnyCodec, body)).toStrictEqual(msg.payload);
        }

        const [msg] = M.parseBatch(hex(msgs.commit_rsp));
        const [, body] = M.decodeResponse(M.BkpRestoreCommitRsp, msg.payload);
        const st = r.ncp_state;
        expect(body).toStrictEqual({
            nwkFcStart: st.nwk_fc_start,
            apsFcStart: st.aps_fc_start,
            linkKeysOnNcp: st.link_keys_on_ncp,
            linkKeysHostBacked: st.link_keys_host_backed,
            children: st.children,
        });
    });

    it("ocb_roundtrip.json NCP model and export", () => {
        const r = rt.restore;
        const recs = ocbToRecords(rt.input_ocb);
        const model = applyRestore(recs, r.nwk_margin, r.aps_margin);
        expect(model).toStrictEqual({nwkFcStart: r.ncp_state.nwk_fc_start, apsFcStart: r.ncp_state.aps_fc_start});
        expect(model.nwkFcStart + FC_STRIDE).toStrictEqual(r.ncp_state.nwk_fc_limit);
        expect(model.apsFcStart + FC_STRIDE).toStrictEqual(r.ncp_state.aps_fc_limit);
        const exported = rt.export.records.map((x: Json) => decodeRecords(hex(x.hex))[0]);
        const out = recordsToOcb(exported, {
            source: "zigbee-rs-reference@spec-v1",
            creationTime: "2026-11-15T12:00:00+00:00",
            passthroughStackSpecific: {},
        });
        expect(out).toStrictEqual(rt.output_ocb);
        // Property 1: the output converts back to byte-identical DEVICE records.
        const again = ocbToRecords(out);
        const devs = (xs: ZrhpRecord[]): string[] => xs.filter((x) => x.type === RecordType.DEVICE).map((x) => encodeRecord(x).toString("hex"));
        expect(devs(again)).toStrictEqual(devs(exported));
        // Property 2: zero-margin restore of the output starts at the exported limits.
        expect(applyRestore(again, 0, 0)).toStrictEqual({nwkFcStart: r.ncp_state.nwk_fc_limit, apsFcStart: r.ncp_state.aps_fc_limit});
    });

    it("ocb_z2m_import.json", () => {
        const recs = ocbToRecords(structuredClone(z2m.input_ocb));
        expect(recs.map((r) => encodeRecord(r).toString("hex"))).toStrictEqual(z2m.records.map((r: Json) => r.hex));
        const [nwkMargin, apsMargin] = restoreMargins(z2m.input_ocb, z2m.nwk_margin);
        expect([nwkMargin, apsMargin]).toStrictEqual([z2m.nwk_margin, z2m.aps_margin]);
        expect(applyRestore(recs, nwkMargin, apsMargin)).toStrictEqual({
            nwkFcStart: z2m.ncp_state.nwk_fc_start,
            apsFcStart: z2m.ncp_state.aps_fc_start,
        });
        expect(restoreMargins(rt.input_ocb)).toStrictEqual([0, 10_000]);
    });
});

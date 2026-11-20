/** ZRHP link frames (spec 5.2-5.4): header, CRC, COBS wire form and frame bodies. */

import {cobsEncode} from "./cobs";
import {crc32c} from "./crc";

export const LINK_VERSION = 1;
export const HEADER_LEN = 8;
export const CRC_LEN = 4;
export const MAX_PAYLOAD = 640;

export const CTRL_POLL = 0x20;
export const CTRL_RETX = 0x10;

export enum FrameType {
    DATA = 0,
    ACK = 1,
    NAK = 2,
    RESET_REQ = 3,
    RESET_ACK = 4,
    REJECT = 5,
}

export enum Role {
    HOST = 0,
    NCP = 1,
}

export enum ResetReason {
    POWER_ON = 0,
    PEER_TIMEOUT = 1,
    PROTOCOL_ERROR = 2,
    RETRY_EXHAUSTED = 3,
    HOST_OPEN = 4,
    PEER_REQUESTED = 5,
    WATCHDOG = 6,
    FIRMWARE_UPDATE = 7,
}

export enum RejectReason {
    NO_CREDIT = 1,
    TOO_LONG = 2,
    UNKNOWN_ENDPOINT = 3,
    UNSUPPORTED = 4,
    WINDOW_VIOLATION = 5,
    STALE_EPOCH = 6,
    NOT_IN_SESSION = 7,
}

/** A decoded frame failed validation. Length and CRC errors are line noise; version/type errors are peer bugs. */
export class FrameError extends Error {
    readonly kind: "length" | "crc" | "version" | "type";

    constructor(kind: "length" | "crc" | "version" | "type") {
        super(kind);
        this.kind = kind;
    }

    get isNoise(): boolean {
        return this.kind === "length" || this.kind === "crc";
    }
}

export interface Header {
    type: FrameType;
    epoch: number;
    endpoint: number;
    seq: number;
    ack: number;
    epSeq: number;
    poll: boolean;
    retx: boolean;
}

export function header(type: FrameType, fields: Partial<Omit<Header, "type">> = {}): Header {
    return {type, epoch: 0, endpoint: 0, seq: 0, ack: 0, epSeq: 0, poll: false, retx: false, ...fields};
}

export interface Frame {
    header: Header;
    payload: Buffer;
}

/** Decoded frame: header + payload + CRC-32C. */
export function encodeFrame(h: Header, payload: Uint8Array = Buffer.alloc(0)): Buffer {
    if (payload.length > MAX_PAYLOAD) {
        throw new Error("payload too long");
    }

    const out = Buffer.alloc(HEADER_LEN + payload.length + CRC_LEN);
    out[0] = (LINK_VERSION << 6) | (h.poll ? CTRL_POLL : 0) | (h.retx ? CTRL_RETX : 0) | h.type;
    out[1] = h.epoch;
    out[2] = h.endpoint;
    out[3] = h.seq;
    out[4] = h.ack;
    out[5] = h.epSeq;
    out.writeUInt16LE(payload.length, 6);
    out.set(payload, HEADER_LEN);
    out.writeUInt32LE(crc32c(out.subarray(0, HEADER_LEN + payload.length)), HEADER_LEN + payload.length);

    return out;
}

/** Wire bytes: optional leading `0x00`, COBS, delimiter. */
export function encodeWire(h: Header, payload: Uint8Array = Buffer.alloc(0), leadZero = false): Buffer {
    const enc = cobsEncode(encodeFrame(h, payload));

    return Buffer.concat([leadZero ? Buffer.from([0]) : Buffer.alloc(0), enc, Buffer.from([0])]);
}

/** Validate a decoded frame (length, CRC, version, type), in that order. */
export function parseFrame(decoded: Buffer): Frame {
    if (decoded.length < HEADER_LEN + CRC_LEN) {
        throw new FrameError("length");
    }

    const length = decoded.readUInt16LE(6);

    if (decoded.length !== HEADER_LEN + length + CRC_LEN) {
        throw new FrameError("length");
    }

    const end = HEADER_LEN + length;

    if (crc32c(decoded.subarray(0, end)) !== decoded.readUInt32LE(end)) {
        throw new FrameError("crc");
    }

    const ctrl = decoded[0];

    if (ctrl >> 6 !== LINK_VERSION) {
        throw new FrameError("version");
    }

    const type = ctrl & 0x0f;

    if (type > FrameType.REJECT) {
        throw new FrameError("type");
    }

    return {
        header: {
            type,
            epoch: decoded[1],
            endpoint: decoded[2],
            seq: decoded[3],
            ack: decoded[4],
            epSeq: decoded[5],
            poll: (ctrl & CTRL_POLL) !== 0,
            retx: (ctrl & CTRL_RETX) !== 0,
        },
        payload: Buffer.from(decoded.subarray(HEADER_LEN, end)),
    };
}

/** `1 + crc32c(le32(host) || le32(ncp)) mod 255` (spec 5.5). */
export function sessionEpoch(hostCookie: number, ncpCookie: number): number {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(hostCookie >>> 0, 0);
    b.writeUInt32LE(ncpCookie >>> 0, 4);

    return 1 + (crc32c(b) % 255);
}

export type Credits = [endpoint: number, value: number][];

export interface ResetBody {
    cookie: number;
    peerCookie: number;
    role: number;
    linkVersion: number;
    rxWindow: number;
    reason: number;
    rxMtu: number;
    ackDelayUs: number;
    keepaliveMs: number;
    linkTimeoutMs: number;
    credits: Credits;
}

const RESET_FIXED_LEN = 21;

export function resetBody(fields: Pick<ResetBody, "cookie" | "peerCookie" | "role"> & Partial<ResetBody>): ResetBody {
    return {
        linkVersion: LINK_VERSION,
        rxWindow: 32,
        reason: 0,
        rxMtu: MAX_PAYLOAD,
        ackDelayUs: 1000,
        keepaliveMs: 500,
        linkTimeoutMs: 3000,
        credits: [],
        ...fields,
    };
}

export function encodeResetBody(b: ResetBody): Buffer {
    const out = Buffer.alloc(RESET_FIXED_LEN + 2 * b.credits.length);
    out.writeUInt32LE(b.cookie >>> 0, 0);
    out.writeUInt32LE(b.peerCookie >>> 0, 4);
    out[8] = b.role;
    out[9] = b.linkVersion;
    out[10] = b.rxWindow;
    out[11] = b.reason;
    out.writeUInt16LE(b.rxMtu, 12);
    out.writeUInt16LE(b.ackDelayUs, 14);
    out.writeUInt16LE(b.keepaliveMs, 16);
    out.writeUInt16LE(b.linkTimeoutMs, 18);
    out[20] = b.credits.length;

    for (const [i, [ep, c]] of b.credits.entries()) {
        out[RESET_FIXED_LEN + 2 * i] = ep;
        out[RESET_FIXED_LEN + 2 * i + 1] = c;
    }

    return out;
}

function parseCredits(payload: Buffer, offset: number, n: number): Credits {
    if (payload.length < offset + 2 * n) {
        throw new Error("truncated credits");
    }

    const credits: Credits = [];

    for (let i = 0; i < n; i++) {
        credits.push([payload[offset + 2 * i], payload[offset + 2 * i + 1]]);
    }

    return credits;
}

export function parseResetBody(payload: Buffer): ResetBody {
    if (payload.length < RESET_FIXED_LEN) {
        throw new Error("truncated RESET body");
    }

    return {
        cookie: payload.readUInt32LE(0),
        peerCookie: payload.readUInt32LE(4),
        role: payload[8],
        linkVersion: payload[9],
        rxWindow: payload[10],
        reason: payload[11],
        rxMtu: payload.readUInt16LE(12),
        ackDelayUs: payload.readUInt16LE(14),
        keepaliveMs: payload.readUInt16LE(16),
        linkTimeoutMs: payload.readUInt16LE(18),
        credits: parseCredits(payload, RESET_FIXED_LEN, payload[20]),
    };
}

export interface AckBody {
    sack: number;
    nbad: number;
    credits: Credits;
}

export function encodeAckBody(b: AckBody): Buffer {
    const out = Buffer.alloc(6 + 2 * b.credits.length);
    out.writeUInt32LE(b.sack >>> 0, 0);
    out[4] = b.nbad;
    out[5] = b.credits.length;

    for (const [i, [ep, c]] of b.credits.entries()) {
        out[6 + 2 * i] = ep;
        out[7 + 2 * i] = c;
    }

    return out;
}

export function parseAckBody(payload: Buffer): AckBody {
    if (payload.length < 6) {
        throw new Error("truncated ACK body");
    }

    return {sack: payload.readUInt32LE(0), nbad: payload[4], credits: parseCredits(payload, 6, payload[5])};
}

export interface RejectBody {
    seq: number;
    endpoint: number;
    epSeq: number;
    reason: number;
}

export function encodeRejectBody(b: RejectBody): Buffer {
    return Buffer.from([b.seq, b.endpoint, b.epSeq, b.reason]);
}

export function parseRejectBody(payload: Buffer): RejectBody {
    if (payload.length < 4) {
        throw new Error("truncated REJECT body");
    }

    return {seq: payload[0], endpoint: payload[1], epSeq: payload[2], reason: payload[3]};
}

/**
 * ZRHP link test harness: a scripted peer and two-link simulations on a virtual clock.
 *
 * Mirrors `zigbee-zrhp/tests/common/harness.rs` and `zigpy-zrhp/tests/link_rig.py`.
 */

import {expect} from "vitest";
import {CobsAccumulator} from "../../../src/adapter/zrhp/cobs";
import {Kind, LinkEndpoint} from "../../../src/adapter/zrhp/consts";
import {
    type AckBody,
    type Credits,
    encodeAckBody,
    encodeResetBody,
    encodeWire,
    type Frame,
    FrameType,
    type Header,
    header,
    parseAckBody,
    parseFrame,
    ResetReason,
    Role,
    resetBody,
    sessionEpoch,
} from "../../../src/adapter/zrhp/frame";
import {Link, type LinkConfig, type LinkEvent, NO_SOURCE, type TxSource} from "../../../src/adapter/zrhp/link";
import {encodeMessage} from "../../../src/adapter/zrhp/messages";

export const PEER_COOKIE = 0x1a2b3c4d;
export const OWN_COOKIE = 0xc0ffee01;

/** Seeded PRNG (mulberry32), returns [0, 1). */
export function rng(seed: number): () => number {
    let a = (seed + 0x6d2b79f5) >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface Sent {
    t: number;
    header: Header;
    payload: Buffer;
}

export function ackBodyOf(s: Sent): AckBody {
    return parseAckBody(s.payload);
}

export function decodeWire(data: Buffer): Frame[] {
    const acc = new CobsAccumulator();
    const out: Frame[] = [];

    for (const b of data) {
        const r = acc.push(b);

        if (r instanceof Buffer) {
            out.push(parseFrame(r));
        }
    }

    return out;
}

export function wire(h: Header, payload: Buffer): Buffer {
    return encodeWire(h, payload);
}

export function tagged(tag: number): Buffer {
    return encodeMessage({kind: Kind.REQUEST, msgId: 0x0201, tid: tag, payload: Buffer.alloc(0)});
}

export function payloadTag(p: Buffer): number {
    return p.readUInt16LE(3);
}

export class OnePerFrame implements TxSource {
    readonly queue: [LinkEndpoint, number][] = [];

    push(ep: LinkEndpoint, tag: number): void {
        this.queue.push([ep, tag]);
    }

    ready(endpoint: LinkEndpoint): boolean {
        return this.queue.some(([e]) => e === endpoint);
    }

    fill(endpoint: LinkEndpoint): Buffer {
        const i = this.queue.findIndex(([e]) => e === endpoint);

        if (i < 0) {
            return Buffer.alloc(0);
        }

        const [[, tag]] = this.queue.splice(i, 1);

        return tagged(tag);
    }
}

/** One link against a scripted peer. */
export class Rig {
    readonly link: Link;
    now = 0;
    readonly sent: Sent[] = [];
    readonly delivered: [LinkEndpoint, Buffer][] = [];
    readonly events: LinkEvent[] = [];
    readonly epoch: number;

    constructor(cfg: LinkConfig, peerWindow: number, peerCredits: Credits, txw = 8, rxw = 8) {
        const peerRole = cfg.role === Role.HOST ? Role.NCP : Role.HOST;
        this.link = new Link(cfg, OWN_COOKIE, txw, rxw);
        this.link.open(0, ResetReason.POWER_ON);
        this.drainTx(NO_SOURCE);
        const p = encodeResetBody(
            resetBody({cookie: PEER_COOKIE, peerCookie: OWN_COOKIE, role: peerRole, rxWindow: peerWindow, reason: 4, credits: peerCredits}),
        );
        this.feed(wire(header(FrameType.RESET_ACK), p));
        this.drainTx(NO_SOURCE);
        const s = this.link.session();
        expect(s).toBeDefined();
        this.epoch = s?.epoch ?? 0;
        const [h, n] = cfg.role === Role.HOST ? [OWN_COOKIE, PEER_COOKIE] : [PEER_COOKIE, OWN_COOKIE];
        expect(this.epoch).toStrictEqual(sessionEpoch(h, n));
        this.sent.length = 0;
        this.events.length = 0;
    }

    feed(data: Buffer): void {
        let off = 0;

        while (off < data.length) {
            off += this.link.pushRx(data.subarray(off), this.now);
            this.drainEvents();
        }
    }

    drainEvents(): void {
        for (let ev = this.link.pollEvent(); ev !== undefined; ev = this.link.pollEvent()) {
            if (ev.type === "data") {
                this.delivered.push([ev.endpoint, ev.payload]);
            } else {
                this.events.push(ev);
            }
        }
    }

    drainTx(src: TxSource): number {
        let count = 0;

        for (let w = this.link.pollTransmit(this.now, src); w !== undefined; w = this.link.pollTransmit(this.now, src)) {
            for (const f of decodeWire(w)) {
                this.sent.push({t: this.now, header: f.header, payload: f.payload});
            }

            count++;
            expect(count).toBeLessThan(10_000);
        }

        this.drainEvents();

        return count;
    }

    advance(to: number, src: TxSource): void {
        let guard = 0;

        for (let d = this.link.nextDeadline(); d !== undefined && d <= to; d = this.link.nextDeadline()) {
            this.now = Math.max(this.now, d);

            if (this.drainTx(src) === 0 && this.link.nextDeadline() === d) {
                break;
            }

            guard++;
            expect(guard).toBeLessThan(10_000);
        }

        this.now = Math.max(this.now, to);
        this.drainTx(src);
    }

    dataHeader(seq: number, endpoint: number, epSeq: number): Header {
        return header(FrameType.DATA, {epoch: this.epoch, endpoint, seq, epSeq});
    }

    ackFrame(type: FrameType, ack: number, sack: number, nbad = 0, credits: Credits = []): Buffer {
        return wire(header(type, {epoch: this.epoch, ack}), encodeAckBody({sack, nbad, credits}));
    }
}

/** A TX source of whole messages per endpoint with opportunistic batching. */
export class QueueSource implements TxSource {
    readonly queues = new Map<LinkEndpoint, Buffer[]>();

    push(ep: LinkEndpoint, message: Buffer): void {
        const q = this.queues.get(ep) ?? [];
        q.push(message);
        this.queues.set(ep, q);
    }

    ready(endpoint: LinkEndpoint): boolean {
        return (this.queues.get(endpoint)?.length ?? 0) > 0;
    }

    fill(endpoint: LinkEndpoint, mtu: number): Buffer {
        const q = this.queues.get(endpoint) ?? [];
        const out: Buffer[] = [];
        let len = 0;

        while (q.length > 0 && len + q[0].length <= mtu) {
            const m = q.shift() as Buffer;
            out.push(m);
            len += m.length;
        }

        return Buffer.concat(out);
    }
}

export interface ChannelOptions {
    ber?: number;
    drop?: number;
    zeroInsert?: number;
    dup?: number;
    latencyUs?: number;
}

/** A unidirectional byte pipe with optional fault injection. */
export class Channel {
    readonly rand: () => number;
    readonly ber: number;
    readonly drop: number;
    readonly zeroInsert: number;
    readonly dup: number;
    readonly latencyUs: number;
    readonly inflight: [number, Buffer][] = [];
    blocked = false;
    /** Optional hook replacing {@link send} (fault scripting). */
    filter: ((data: Buffer) => boolean) | undefined;

    constructor(rand: () => number = rng(0), o: ChannelOptions = {}) {
        this.rand = rand;
        this.ber = o.ber ?? 0;
        this.drop = o.drop ?? 0;
        this.zeroInsert = o.zeroInsert ?? 0;
        this.dup = o.dup ?? 0;
        this.latencyUs = o.latencyUs ?? 200;
    }

    send(now: number, data: Buffer): void {
        if (this.filter && !this.filter(data)) {
            return;
        }

        const out: number[] = [];

        for (let b of data) {
            if (this.drop && this.rand() < this.drop) {
                continue;
            }

            if (this.ber) {
                for (let bit = 0; bit < 8; bit++) {
                    if (this.rand() < this.ber) {
                        b ^= 1 << bit;
                    }
                }
            }

            out.push(b);

            if (this.zeroInsert && this.rand() < this.zeroInsert) {
                out.push(0);
            }
        }

        const chunk = Buffer.from(out);
        this.inflight.push([now + this.latencyUs, chunk]);

        if (this.dup && this.rand() < this.dup) {
            this.inflight.push([now + this.latencyUs, chunk]);
        }
    }

    due(now: number): Buffer {
        if (this.blocked) {
            return Buffer.alloc(0);
        }

        const out: Buffer[] = [];

        while (this.inflight.length > 0 && this.inflight[0][0] <= now) {
            out.push((this.inflight.shift() as [number, Buffer])[1]);
        }

        return Buffer.concat(out);
    }

    nextTime(): number | undefined {
        return this.blocked || this.inflight.length === 0 ? undefined : this.inflight[0][0];
    }
}

export class Side {
    readonly link: Link;
    readonly source: QueueSource;
    readonly delivered: [LinkEndpoint, Buffer][] = [];
    readonly events: LinkEvent[] = [];

    constructor(link: Link, source: QueueSource) {
        this.link = link;
        this.source = source;
    }

    feed(now: number, data: Buffer): void {
        let off = 0;

        while (off < data.length) {
            off += this.link.pushRx(data.subarray(off), now);
            this.drainEvents();
        }
    }

    drainEvents(): void {
        for (let ev = this.link.pollEvent(); ev !== undefined; ev = this.link.pollEvent()) {
            if (ev.type === "data") {
                this.delivered.push([ev.endpoint, ev.payload]);
            } else {
                this.events.push(ev);
            }
        }
    }
}

export interface PairOptions {
    hostCfg?: LinkConfig;
    ncpCfg?: LinkConfig;
    a2b?: Channel;
    b2a?: Channel;
    hostCookie?: number;
    ncpCookie?: number;
    txw?: number;
    rxw?: number;
}

/** Host and NCP links connected by two channels on a virtual clock. */
export class Pair {
    now = 0;
    readonly host: Side;
    readonly ncp: Side;
    readonly h2n: Channel;
    readonly n2h: Channel;

    constructor(hostCfg: LinkConfig, ncpCfg: LinkConfig, o: PairOptions = {}) {
        this.host = new Side(new Link(o.hostCfg ?? hostCfg, o.hostCookie ?? PEER_COOKIE, o.txw ?? 32, o.rxw ?? 32), new QueueSource());
        this.ncp = new Side(new Link(o.ncpCfg ?? ncpCfg, o.ncpCookie ?? OWN_COOKIE, 16, 16), new QueueSource());
        this.h2n = o.a2b ?? new Channel();
        this.n2h = o.b2a ?? new Channel();
    }

    open(): void {
        this.host.link.open(this.now, ResetReason.HOST_OPEN);
        this.ncp.link.open(this.now, ResetReason.POWER_ON);
    }

    private pumpTx(side: Side, ch: Channel): void {
        for (let w = side.link.pollTransmit(this.now, side.source); w !== undefined; w = side.link.pollTransmit(this.now, side.source)) {
            ch.send(this.now, w);
        }

        side.drainEvents();
    }

    step(): void {
        this.pumpTx(this.host, this.h2n);
        this.pumpTx(this.ncp, this.n2h);
        let data = this.h2n.due(this.now);

        if (data.length > 0) {
            this.ncp.feed(this.now, data);
        }

        data = this.n2h.due(this.now);

        if (data.length > 0) {
            this.host.feed(this.now, data);
        }

        this.pumpTx(this.host, this.h2n);
        this.pumpTx(this.ncp, this.n2h);
    }

    run(until: number, stop?: () => boolean, maxStep = 1000): void {
        let guard = 0;

        while (this.now < until) {
            this.step();

            if (stop?.()) {
                return;
            }

            const cands = [this.host.link.nextDeadline(), this.ncp.link.nextDeadline(), this.h2n.nextTime(), this.n2h.nextTime()].filter(
                (t): t is number => t !== undefined,
            );
            const nxt = cands.length > 0 ? Math.min(...cands) : until;
            this.now = Math.max(this.now + 1, Math.min(nxt, this.now + maxStep, until));
            guard++;
            expect(guard).toBeLessThan(2_000_000);
        }

        this.step();
    }
}

export const ZIGBEE = LinkEndpoint.ZIGBEE;

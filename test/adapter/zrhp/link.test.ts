/** Normative ARQ traces (`arq_scenarios.json`, spec 5.9) and link conformance / fault tests (spec 14.2). */

import {describe, expect, it} from "vitest";
import {Kind, LinkEndpoint} from "../../../src/adapter/zrhp/consts";
import {encodeRejectBody, encodeWire, FrameType, header, parseRejectBody, ResetReason, Role, sessionEpoch} from "../../../src/adapter/zrhp/frame";
import {Link, type LinkConfig, LinkConfigs, type LinkEvent, LinkState, NO_SOURCE, PeerChange, TxFailure} from "../../../src/adapter/zrhp/link";
import {encodeMessage, parseBatch} from "../../../src/adapter/zrhp/messages";
import {
    ackBodyOf,
    Channel,
    decodeWire,
    OnePerFrame,
    OWN_COOKIE,
    Pair,
    type PairOptions,
    PEER_COOKIE,
    payloadTag,
    Rig,
    rng,
    tagged,
    wire,
} from "./linkRig";
import {type Json, loadVector} from "./vectorUtils";

const ARQ = loadVector("arq_scenarios.json");
const A = ARQ.assumptions;

function config(role: Role): LinkConfig {
    const base = role === Role.NCP ? LinkConfigs.ncp() : LinkConfigs.embeddedHost();

    return {
        ...base,
        rxWindow: A.rx_window,
        ackDelayUs: A.ack_delay_us,
        rtoInitialUs: A.rto_initial_us,
        adaptiveRto: A.rto_adaptive,
        autoCredit: false,
    };
}

function runReceiver(sc: Json): void {
    const name = sc.name;
    const cfg = config(Role.NCP);
    const credits = [...cfg.initialCredits];

    for (const [ep, v] of Object.entries(sc.initial_credit_edge ?? {})) {
        credits[Number(ep)] = v as number;
    }

    cfg.initialCredits = credits;
    expect(Math.floor(cfg.rxWindow / 2)).toStrictEqual(A.ack_every_frames);
    const rig = new Rig(cfg, 8, [
        [1, 4],
        [2, 8],
        [3, 4],
        [4, 4],
        [5, 2],
    ]);
    let end = 0;

    for (const inp of sc.inputs) {
        const t = inp.t;
        end = Math.max(end, t);
        rig.advance(t, NO_SOURCE);

        if (inp.data !== undefined) {
            const seq = inp.data;
            const h = rig.dataHeader(seq, inp.endpoint ?? LinkEndpoint.ZIGBEE, inp.ep_seq ?? seq);
            h.retx = inp.retx ?? false;
            h.poll = inp.poll ?? false;
            rig.feed(wire(h, tagged(seq)));
        } else if (inp.crc_error) {
            const w = Buffer.from(wire(rig.dataHeader(9, LinkEndpoint.ZIGBEE, 9), tagged(999)));
            w[w.length - 3] ^= 0x55;
            expect(w.subarray(0, -1).includes(0)).toStrictEqual(false);
            rig.feed(w);
        } else if (inp.consumer_frees !== undefined) {
            rig.link.releaseCredit(inp.consumer_frees.endpoint, inp.consumer_frees.frames);
        } else {
            throw new Error(`${name}: unknown input`);
        }

        rig.drainTx(NO_SOURCE);
    }

    for (const e of sc.expect) {
        end = Math.max(end, e.t);
    }

    rig.advance(end + 5_000, NO_SOURCE);
    const got = rig.sent.filter((s) => s.header.type !== FrameType.DATA);
    expect(got.length, name).toStrictEqual(sc.expect.length);

    for (const [i, e] of sc.expect.entries()) {
        const s = got[i];
        expect(s.t, name).toStrictEqual(e.t);
        expect(s.header.type, name).toStrictEqual(e.send === "ACK" ? FrameType.ACK : FrameType.NAK);
        expect(s.header.ack, name).toStrictEqual(e.ack);
        expect(s.header.epoch).toStrictEqual(rig.epoch);
        const body = ackBodyOf(s);
        expect(body.sack, name).toStrictEqual(e.sack);
        expect(body.nbad, name).toStrictEqual(e.nbad ?? 0);
        expect(body.credits, name).toStrictEqual(Object.entries(e.credits ?? {}).map(([k, v]) => [Number(k), v]));
    }

    if (sc.delivered !== undefined) {
        expect(
            rig.delivered.map(([, p]) => payloadTag(p)),
            name,
        ).toStrictEqual(sc.delivered);
    }

    for (const [k, v] of Object.entries(sc.counters ?? {})) {
        const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof typeof rig.link.counters;
        expect(rig.link.counters[camel], `${name} ${k}`).toStrictEqual(v);
    }
}

function runSender(sc: Json): void {
    const name = sc.name;
    const rig = new Rig(config(Role.HOST), A.rx_window, [
        [1, 4],
        [2, 8],
        [3, 4],
        [4, 2],
        [5, 0],
    ]);
    const src = new OnePerFrame();
    let end = 0;

    for (const inp of sc.inputs) {
        end = Math.max(end, inp.t);
        rig.advance(inp.t, src);

        if (inp.send_new !== undefined) {
            const before = rig.sent.length;

            for (const s of inp.send_new) {
                src.push(LinkEndpoint.ZIGBEE, s);
            }

            rig.drainTx(src);
            const fresh = rig.sent.slice(before);
            expect(
                fresh.map((s) => s.header.seq),
                name,
            ).toStrictEqual(inp.send_new);
            expect(fresh.every((s) => !s.header.retx && s.header.type === FrameType.DATA)).toStrictEqual(true);
        } else if (inp.recv !== undefined) {
            rig.feed(rig.ackFrame(inp.recv === "ACK" ? FrameType.ACK : FrameType.NAK, inp.ack, inp.sack, inp.nbad ?? 0));
        } else {
            throw new Error(name);
        }

        rig.drainTx(src);
    }

    for (const e of sc.expect) {
        end = Math.max(end, e.t);
    }

    rig.advance(end + 5_000, src);
    const retx = rig.sent.filter((s) => s.header.retx || s.header.type !== FrameType.DATA);
    expect(retx.length, name).toStrictEqual(sc.expect.length);

    for (const [i, e] of sc.expect.entries()) {
        const s = retx[i];
        expect(s.header.type).toStrictEqual(FrameType.DATA);
        expect(s.t, name).toStrictEqual(e.t);
        expect(s.header.seq, name).toStrictEqual(e.retransmit);
        expect(s.header.retx).toStrictEqual(e.flags.includes("RETX"));
        expect(s.header.poll).toStrictEqual(e.flags.includes("POLL"));
        expect(payloadTag(s.payload), "byte-identical payload").toStrictEqual(s.header.seq);
    }

    const fin = sc.final;
    expect(rig.link.txBase, name).toStrictEqual(fin.base);
    expect(
        rig.link.txUnacked().sort((a, b) => a - b),
        name,
    ).toStrictEqual(fin.unacked);

    if (fin.rto_us !== undefined) {
        expect(rig.link.rtoUs, name).toStrictEqual(fin.rto_us);
    }
}

describe("ZRHP ARQ traces (arq_scenarios.json)", () => {
    it("has all scenarios", () => {
        expect(ARQ.scenarios.length).toStrictEqual(8);
    });

    it.each(ARQ.scenarios.map((s: Json) => [s.name, s]))("%s", (_name, sc: Json) => {
        (sc.role === "receiver" ? runReceiver : runSender)(sc);
    });
});

// #region Link conformance and fault tests

const LINK: Record<string, Json> = Object.fromEntries(loadVector("link_frames.json").vectors.map((v: Json) => [v.name, v]));

function msg(tag: number, size = 0): Buffer {
    return encodeMessage({kind: Kind.EVENT, msgId: 0x0280, tid: tag & 0xffff, payload: Buffer.alloc(size, tag & 0xff)});
}

function newPair(o: PairOptions = {}): Pair {
    return new Pair(LinkConfigs.desktopHost(), LinkConfigs.ncp(), o);
}

function establishedPair(o: PairOptions = {}): Pair {
    const p = newPair(o);
    p.open();
    p.run(50_000, () => p.host.link.session() !== undefined && p.ncp.link.session() !== undefined);
    expect(p.host.link.session()).toBeDefined();
    expect(p.ncp.link.session()).toBeDefined();

    return p;
}

function count(delivered: [LinkEndpoint, Buffer][]): number {
    return delivered.reduce((n, [, pl]) => n + parseBatch(pl).length, 0);
}

function checkOrder(delivered: [LinkEndpoint, Buffer][], n: number): void {
    const perEp = new Map<LinkEndpoint, number[]>();

    for (const [ep, payload] of delivered) {
        for (const m of parseBatch(payload)) {
            perEp.set(ep, [...(perEp.get(ep) ?? []), m.tid]);
        }
    }

    expect([...perEp.values()].reduce((a, v) => a + v.length, 0)).toStrictEqual(n);

    for (const tids of perEp.values()) {
        expect(tids, "per-endpoint order").toStrictEqual([...tids].sort((a, b) => a - b));
        expect(new Set(tids).size, "exactly once").toStrictEqual(tids.length);
    }
}

function exchange(p: Pair, n: number, size = 40, until = 60_000_000): void {
    const eps = [LinkEndpoint.ZIGBEE, LinkEndpoint.SYSTEM, LinkEndpoint.BULK];
    const r = rng(1);

    for (let i = 0; i < n; i++) {
        const ep = eps[i % eps.length];
        p.host.source.push(ep, msg(i, Math.floor(r() * size)));
        p.ncp.source.push(ep === LinkEndpoint.SYSTEM ? LinkEndpoint.ZIGBEE : ep, msg(i, Math.floor(r() * size)));
    }

    p.run(until, () => count(p.host.delivered) >= n && count(p.ncp.delivered) >= n);
}

const isDown = (e: LinkEvent): boolean => e.type === "linkDown" || e.type === "linkFailed";

describe("ZRHP link conformance", () => {
    it("handshake matches the vectors", () => {
        const p = newPair();
        p.host.link.open(0, ResetReason.HOST_OPEN);
        const first = p.host.link.pollTransmit(0, NO_SOURCE) as Buffer;
        expect(first.toString("hex")).toStrictEqual(`00${LINK.reset_req_host.wire_hex}`);
        p.ncp.link.open(0, ResetReason.POWER_ON);
        p.ncp.link.pollTransmit(0, NO_SOURCE); // its own RESET_REQ
        p.ncp.feed(0, first);
        const ack = p.ncp.link.pollTransmit(0, NO_SOURCE) as Buffer;
        const [f] = decodeWire(ack);
        expect(f.header.type).toStrictEqual(FrameType.RESET_ACK);
        expect(encodeWire(f.header, f.payload).toString("hex")).toStrictEqual(LINK.reset_ack_ncp.wire_hex);
        p.host.feed(0, ack);
        const s = p.host.link.session();
        expect(s?.epoch).toStrictEqual(33);
        expect(s?.txWindow).toStrictEqual(16);
        p.run(10_000);
        expect(p.ncp.link.session()?.epoch).toStrictEqual(33);
        expect(p.host.events.some((e) => e.type === "established")).toStrictEqual(true);
    });

    it("clean exchange with batching", () => {
        const p = establishedPair();
        exchange(p, 300);
        checkOrder(p.ncp.delivered, 300);
        checkOrder(p.host.delivered, 300);
        expect(p.host.link.counters.txRetransmissions).toStrictEqual(0);
        expect(p.host.link.counters.txFrames).toBeLessThan(300);
    });

    it.each([0, 1, 2, 3, 4, 5])("noise: every message exactly once, in order (seed %i)", (seed) => {
        const a = new Channel(rng(seed), {ber: 2e-5, drop: 1e-4, zeroInsert: 1e-4, dup: 0.01});
        const b = new Channel(rng(seed + 100), {ber: 2e-5, drop: 1e-4, zeroInsert: 1e-4, dup: 0.01});
        const p = establishedPair({a2b: a, b2a: b});
        exchange(p, 400, 120);
        expect([...p.host.events, ...p.ncp.events].filter(isDown)).toStrictEqual([]);
        checkOrder(p.ncp.delivered, 400);
        checkOrder(p.host.delivered, 400);
        expect(p.host.link.counters.rxBadFrame + p.ncp.link.counters.rxBadFrame).toBeGreaterThan(0);
    });

    it("a lost BULK frame does not block ZIGBEE (no head-of-line blocking)", () => {
        const p = establishedPair();
        p.host.source.push(LinkEndpoint.BULK, msg(1, 300));
        let dropped = false;
        p.h2n.filter = (data) => {
            if (!dropped && decodeWire(data).some((f) => f.header.endpoint === LinkEndpoint.BULK)) {
                dropped = true;
                return false;
            }

            return true;
        };
        p.step();

        for (let i = 2; i < 6; i++) {
            p.host.source.push(LinkEndpoint.ZIGBEE, msg(i));
        }

        p.run(p.now + 500_000, () => count(p.ncp.delivered) >= 5);
        expect(p.ncp.delivered[0][0]).toStrictEqual(LinkEndpoint.ZIGBEE);
        expect(count(p.ncp.delivered.slice(0, 1))).toStrictEqual(4);
        expect(p.ncp.delivered.at(-1)?.[0]).toStrictEqual(LinkEndpoint.BULK);
        expect(p.host.link.counters.txRetransmissions).toStrictEqual(1);
    });

    it("seq wrap 255 -> 0 and the window", () => {
        const p = establishedPair();

        for (let i = 0; i < 700; i++) {
            p.host.source.push(LinkEndpoint.ZIGBEE, msg(i, 600)); // one message per frame
        }

        p.run(120_000_000, () => p.ncp.delivered.length >= 700);
        checkOrder(p.ncp.delivered, 700);
        expect(p.host.link.counters.txFrames).toBeGreaterThan(700);
    });

    it("peer restarted vs resync", () => {
        const p = establishedPair();
        p.ncp.link.reopen(p.now, 0xdeadbeef, ResetReason.POWER_ON);
        p.run(p.now + 200_000, () => p.host.link.session()?.peerCookie === 0xdeadbeef);
        let resets = p.host.events.filter((e) => e.type === "peerReset");
        expect(resets.at(-1)).toMatchObject({change: PeerChange.RESTARTED});
        expect(p.host.link.session()?.epoch).toStrictEqual(sessionEpoch(PEER_COOKIE, 0xdeadbeef));
        p.ncp.link.open(p.now, ResetReason.PEER_TIMEOUT);
        p.run(p.now + 500_000);
        resets = p.host.events.filter((e) => e.type === "peerReset");
        expect(resets.at(-1)).toMatchObject({change: PeerChange.RESYNC});
        expect(p.host.link.state).toStrictEqual(LinkState.ESTABLISHED);
    });

    it("in-flight frames fail with LINK_RESET when the peer restarts", () => {
        const p = establishedPair();
        p.h2n.blocked = true;
        p.host.source.push(LinkEndpoint.ZIGBEE, msg(7));
        p.step();
        p.ncp.link.reopen(p.now, 0xabcdef01, ResetReason.POWER_ON);
        p.h2n.inflight.length = 0;
        p.h2n.blocked = false;
        p.run(p.now + 300_000);
        const failed = p.host.events.filter((e) => e.type === "txFailed");
        expect(failed[0]).toMatchObject({reason: TxFailure.LINK_RESET});
        expect(payloadTag((failed[0] as {payload: Buffer}).payload)).toStrictEqual(7);
    });

    it("retry exhausted resets the session", () => {
        const p = establishedPair();
        p.h2n.blocked = true;
        p.n2h.blocked = true;
        p.host.source.push(LinkEndpoint.ZIGBEE, msg(1));
        p.run(p.now + 20_000_000, () => p.host.events.some(isDown));
        expect(p.host.events.some(isDown)).toStrictEqual(true);
        expect(p.host.link.state).toStrictEqual(LinkState.RESETTING);
    });

    it("retransmission budget exhausted (lossy link to the peer only) reports LINK_FAILED", () => {
        const cfg = {...LinkConfigs.desktopHost(), linkTimeoutMs: 60_000, keepaliveMs: 60_000, nRetxMax: 2};
        const p = establishedPair({hostCfg: cfg});
        p.h2n.filter = (data) => !decodeWire(data).some((f) => f.header.type === FrameType.DATA);
        p.host.source.push(LinkEndpoint.ZIGBEE, msg(1));
        p.run(p.now + 10_000_000, () => p.host.events.some((e) => e.type === "linkFailed"));
        expect(p.host.events.some((e) => e.type === "linkFailed")).toStrictEqual(true);
    });

    it("link down after silence, then recovers", () => {
        const p = establishedPair();
        p.n2h.blocked = true;
        p.h2n.blocked = true;
        p.run(p.now + 4_000_000, () => p.host.events.some((e) => e.type === "linkDown"));
        expect(p.host.events.some((e) => e.type === "linkDown")).toStrictEqual(true);
        p.n2h.blocked = false;
        p.h2n.blocked = false;
        p.n2h.inflight.length = 0;
        p.h2n.inflight.length = 0;
        p.run(p.now + 5_000_000, () => p.host.link.session() !== undefined && p.ncp.link.session() !== undefined);
        expect(p.host.link.session()).toBeDefined();
    });

    it("stale-epoch DATA is rejected", () => {
        const rig = new Rig(LinkConfigs.ncp(), 8, [
            [1, 4],
            [2, 8],
            [3, 4],
            [4, 4],
            [5, 2],
        ]);
        const h = rig.dataHeader(0, 2, 0);
        h.epoch = (rig.epoch + 1) & 0xff || 1;
        rig.feed(wire(h, tagged(1)));
        rig.drainTx(NO_SOURCE);
        const rejects = rig.sent.filter((s) => s.header.type === FrameType.REJECT);
        expect(parseRejectBody(rejects[0].payload).reason).toStrictEqual(6);
        expect(rig.link.counters.rxEpochMismatch).toStrictEqual(1);
        expect(rig.delivered).toStrictEqual([]);
    });

    it("REJECT NO_CREDIT consumes the seq", () => {
        const rig = new Rig(LinkConfigs.ncp(), 8, [
            [1, 4],
            [2, 8],
            [3, 4],
            [4, 4],
            [5, 2],
        ]);
        rig.feed(wire(rig.dataHeader(0, LinkEndpoint.LOG, 0), tagged(1)));
        rig.feed(wire(rig.dataHeader(1, LinkEndpoint.ZIGBEE, 0), tagged(2)));
        rig.drainTx(NO_SOURCE);
        const rejects = rig.sent.filter((s) => s.header.type === FrameType.REJECT).map((s) => parseRejectBody(s.payload));
        expect(rejects[0]).toMatchObject({reason: 1, seq: 0});
        expect(rig.link.rxAck).toStrictEqual(2);
        expect(rig.delivered.map(([, p]) => payloadTag(p))).toStrictEqual([2]);
    });

    it("REJECT UNKNOWN_ENDPOINT and WINDOW_VIOLATION", () => {
        const rig = new Rig(LinkConfigs.ncp(), 8, [[2, 8]]);
        rig.feed(wire(rig.dataHeader(0, 9, 0), tagged(1)));
        rig.feed(wire(rig.dataHeader(40, LinkEndpoint.ZIGBEE, 0), tagged(2)));
        rig.drainTx(NO_SOURCE);
        const reasons = rig.sent.filter((s) => s.header.type === FrameType.REJECT).map((s) => parseRejectBody(s.payload).reason);
        expect(reasons).toStrictEqual([3, 5]);
        expect(rig.link.rxAck).toStrictEqual(1);
    });

    it("the sender reports a rejected frame; WINDOW_VIOLATION resets", () => {
        const rig = new Rig(LinkConfigs.desktopHost(), 8, [
            [1, 4],
            [2, 8],
            [3, 4],
            [4, 2],
            [5, 0],
        ]);
        const src = new OnePerFrame();
        src.push(LinkEndpoint.ZIGBEE, 5);
        src.push(LinkEndpoint.ZIGBEE, 6);
        rig.drainTx(src);
        rig.feed(wire(header(FrameType.REJECT, {epoch: rig.epoch, ack: 1}), encodeRejectBody({seq: 0, endpoint: 2, epSeq: 0, reason: 1})));
        const failed = rig.events.filter((e) => e.type === "txFailed");
        expect(failed[0]).toMatchObject({reason: TxFailure.REJECTED, rejectReason: 1});
        expect(rig.link.counters.txRejected).toStrictEqual(1);
        rig.feed(wire(header(FrameType.REJECT, {epoch: rig.epoch, ack: 1}), encodeRejectBody({seq: 1, endpoint: 2, epSeq: 1, reason: 5})));
        expect(rig.events.some((e) => e.type === "linkFailed")).toStrictEqual(true);
        expect(rig.link.state).toStrictEqual(LinkState.RESETTING);
    });

    it("unsupported frame types and garbage are counted, not fatal", () => {
        const rig = new Rig(LinkConfigs.desktopHost(), 8, [[2, 8]]);
        const bad = Buffer.from(wire(rig.dataHeader(0, 2, 0), tagged(1)));
        bad[3] ^= 0x01;
        rig.feed(bad);
        rig.feed(Buffer.from([1, 2, 3, 0]));
        rig.feed(Buffer.alloc(700, 0x11));
        rig.feed(Buffer.from([0]));
        rig.link.onLineError(rig.now, true);
        rig.drainTx(NO_SOURCE);
        expect(rig.link.counters.rxBadFrame).toBeGreaterThanOrEqual(3);
        expect(rig.link.counters.rxOverflow).toStrictEqual(1);
        expect(rig.sent.some((s) => s.header.type === FrameType.NAK)).toStrictEqual(true);
        expect(rig.link.state).toStrictEqual(LinkState.ESTABLISHED);
    });

    it("simultaneous RESET_REQ establishes one epoch", () => {
        const p = newPair();
        p.open();
        p.run(100_000, () => p.host.link.session() !== undefined && p.ncp.link.session() !== undefined);
        expect(p.host.link.session()?.epoch).toStrictEqual(p.ncp.link.session()?.epoch);
    });

    it("a lost final RESET_ACK is repaired", () => {
        const p = newPair();
        let dropAcks = 1;
        p.n2h.filter = (data) => {
            if (dropAcks > 0 && decodeWire(data).some((f) => f.header.type === FrameType.RESET_ACK)) {
                dropAcks--;
                return false;
            }

            return true;
        };
        p.open();
        p.run(5_000_000, () => p.host.link.session() !== undefined && p.ncp.link.session() !== undefined);
        expect(p.host.link.session()?.epoch).toStrictEqual(p.ncp.link.session()?.epoch);
    });

    it("keepalive repairs credit", () => {
        const p = establishedPair();

        for (let i = 0; i < 3; i++) {
            p.host.source.push(LinkEndpoint.BULK, msg(i, 600));
        }

        p.run(p.now + 3_000_000, () => p.ncp.delivered.length >= 3);
        expect(p.ncp.delivered.length).toStrictEqual(3);
    });

    it("a minimum host (rx window 4, LOG 0, BULK 1) takes a storm of 1000 indications", () => {
        const hostCfg: LinkConfig = {...LinkConfigs.desktopHost(), rxWindow: 4, initialCredits: [0, 4, 8, 4, 1, 0]};
        const p = establishedPair({hostCfg, txw: 4, rxw: 4});

        for (let i = 0; i < 1000; i++) {
            p.ncp.source.push(LinkEndpoint.ZIGBEE, msg(i, 42));
        }

        p.run(120_000_000, () => count(p.host.delivered) >= 1000);
        expect(count(p.host.delivered)).toStrictEqual(1000);
    });

    it("constructor bounds and accessors", () => {
        expect(() => new Link(LinkConfigs.desktopHost(), 1, 0)).toThrow("txw");
        expect(() => new Link(LinkConfigs.desktopHost(), 1, 8, 2)).toThrow("rxw");
        const p = establishedPair();
        expect(p.host.link.canSend(LinkEndpoint.ZIGBEE)).toStrictEqual(true);
        expect(p.host.link.canSend(LinkEndpoint.LINK)).toStrictEqual(false);
        expect(p.host.link.txInFlight()).toStrictEqual([]);
        expect(p.host.link.txNextSeq).toStrictEqual(0);
        expect(new Link(LinkConfigs.desktopHost(), 1).nextDeadline()).toBeUndefined();
        expect(OWN_COOKIE).toBeGreaterThan(0);
    });
});

// #endregion

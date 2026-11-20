/**
 * Byte streams and the event-loop driver of the ZRHP link.
 *
 * {@link LinkDriver} runs a {@link Link} on a real monotonic clock over a {@link ByteStream} (the herdsman serial transport,
 * a child process in tests, or an in-memory pipe).
 */

import {performance} from "node:perf_hooks";
import {logger} from "../../utils/logger";
import type {LinkEndpoint} from "./consts";
import {ResetReason} from "./frame";
import {Link, type LinkConfig, type LinkEvent, type TxSource} from "./link";

const NS = "zh:zrhp:driver";

export function nowUs(): number {
    return Math.floor(performance.now() * 1000);
}

/** A full-duplex byte stream (USB-Serial-JTAG CDC or UART). */
export interface ByteStream {
    write(data: Buffer): void;
    /** Discard OS input buffers (spec 5.5 step 1); optional. */
    flushInput?(): Promise<void>;
}

/** Per-endpoint message queues feeding the link (opportunistic batching). */
export class EndpointQueues implements TxSource {
    readonly #q = new Map<LinkEndpoint, Buffer[]>();

    push(endpoint: LinkEndpoint, message: Buffer): void {
        const q = this.#q.get(endpoint);

        if (q) {
            q.push(message);
        } else {
            this.#q.set(endpoint, [message]);
        }
    }

    ready(endpoint: LinkEndpoint): boolean {
        return (this.#q.get(endpoint)?.length ?? 0) > 0;
    }

    fill(endpoint: LinkEndpoint, mtu: number): Buffer {
        const q = this.#q.get(endpoint) ?? [];
        const out: Buffer[] = [];
        let len = 0;

        while (q.length > 0 && len + q[0].length <= mtu) {
            const m = q.shift() as Buffer;
            out.push(m);
            len += m.length;
        }

        return Buffer.concat(out);
    }

    /** Remove and return everything still queued. */
    clear(): [LinkEndpoint, Buffer][] {
        const out: [LinkEndpoint, Buffer][] = [];

        for (const [ep, q] of this.#q) {
            for (const m of q) {
                out.push([ep, m]);
            }
        }

        this.#q.clear();

        return out;
    }

    pending(): number {
        let n = 0;

        for (const q of this.#q.values()) {
            n += q.length;
        }

        return n;
    }
}

/** Runs a {@link Link} over a {@link ByteStream} on the Node.js event loop. */
export class LinkDriver {
    stream: ByteStream;
    readonly link: Link;
    readonly queues = new EndpointQueues();
    readonly #onEvent: (ev: LinkEvent) => void;
    readonly #clock: () => number;
    #timer: NodeJS.Timeout | undefined;
    #immediate: NodeJS.Immediate | undefined;
    #running = false;
    #pumping = false;

    constructor(stream: ByteStream, config: LinkConfig, cookie: number, onEvent: (ev: LinkEvent) => void, clock: () => number = nowUs) {
        this.stream = stream;
        this.link = new Link(config, cookie);
        this.#onEvent = onEvent;
        this.#clock = clock;
    }

    start(reason: ResetReason = ResetReason.HOST_OPEN): void {
        this.#running = true;
        this.link.open(this.#clock(), reason);
        this.kick();
    }

    /** Re-run the handshake with a new cookie (port reopened). */
    restart(cookie: number, reason: ResetReason = ResetReason.HOST_OPEN): void {
        this.#running = true;
        this.link.reopen(this.#clock(), cookie, reason);
        this.kick();
    }

    stop(): void {
        this.#running = false;
        clearTimeout(this.#timer);
        this.#timer = undefined;

        if (this.#immediate) {
            clearImmediate(this.#immediate);
            this.#immediate = undefined;
        }
    }

    get running(): boolean {
        return this.#running;
    }

    send(endpoint: LinkEndpoint, message: Buffer): void {
        this.queues.push(endpoint, message);
        this.kick();
    }

    /** Bytes from the transport. */
    receive(data: Buffer): void {
        if (!this.#running) {
            return;
        }

        const now = this.#clock();
        let off = 0;

        while (off < data.length) {
            off += this.link.pushRx(data.subarray(off), now);
            this.drainEvents();
        }

        this.drainEvents();
        this.kick();
    }

    /** Schedule a transmit pass on the next turn of the event loop. */
    kick(): void {
        if (!this.#running || this.#immediate) {
            return;
        }

        this.#immediate = setImmediate(() => {
            this.#immediate = undefined;
            this.pump();
        });
    }

    private drainEvents(): void {
        for (let ev = this.link.pollEvent(); ev !== undefined; ev = this.link.pollEvent()) {
            try {
                this.#onEvent(ev);
            } catch (error) {
                /* v8 ignore next */
                logger.error(`Link event handler failed for ${ev.type}: ${(error as Error).stack}`, NS);
            }
        }
    }

    private pump(): void {
        if (!this.#running || this.#pumping) {
            return;
        }

        this.#pumping = true;

        try {
            const now = this.#clock();

            for (let w = this.link.pollTransmit(now, this.queues); w !== undefined; w = this.link.pollTransmit(now, this.queues)) {
                try {
                    this.stream.write(w);
                } catch (error) {
                    logger.debug(`Write failed: ${(error as Error).message}`, NS);
                }
            }

            this.drainEvents();
        } finally {
            this.#pumping = false;
        }

        clearTimeout(this.#timer);
        this.#timer = undefined;

        if (!this.#running) {
            return;
        }

        const deadline = this.link.nextDeadline();

        if (deadline === undefined) {
            return;
        }

        const delayMs = Math.max(0, (deadline - this.#clock()) / 1000);

        if (deadline === 0 || delayMs === 0) {
            this.kick();
        } else {
            this.#timer = setTimeout(() => {
                this.#timer = undefined;
                this.pump();
            }, Math.ceil(delayMs));
        }
    }
}

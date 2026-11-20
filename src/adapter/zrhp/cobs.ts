/**
 * Consistent Overhead Byte Stuffing, ZRHP spec 5.1.
 *
 * Encoders emit the minimal form: data that ends exactly after a full 254-byte block is closed by that block's `0xFF` code,
 * without a trailing empty `0x01` block. Decoders also accept the non-minimal form.
 */

/** Largest encoded frame accepted by a receiver (8 + 640 + 4 decoded bytes). */
export const MAX_ENCODED_FRAME = 656;

export class CobsError extends Error {}

/** Encode `data` (no delimiter is appended). */
export function cobsEncode(data: Uint8Array): Buffer {
    const out: number[] = [];
    const n = data.length;
    let start = 0;

    for (;;) {
        // A block holds up to 254 non-zero bytes; it is closed by a zero in the data (code = len + 1) or by being full (code 0xFF).
        const limit = Math.min(n, start + 254);
        let zero = -1;

        for (let i = start; i < limit; i++) {
            if (data[i] === 0) {
                zero = i;
                break;
            }
        }

        if (zero >= 0) {
            out.push(zero - start + 1);

            for (let i = start; i < zero; i++) {
                out.push(data[i]);
            }

            start = zero + 1;

            if (start === n) {
                out.push(1); // the data ends with a zero: empty last block
                return Buffer.from(out);
            }

            continue;
        }

        out.push(limit - start + 1);

        for (let i = start; i < limit; i++) {
            out.push(data[i]);
        }

        start = limit;

        if (start >= n) {
            return Buffer.from(out);
        }
    }
}

/** Decode one COBS frame (without its delimiter). */
export function cobsDecode(data: Uint8Array): Buffer {
    const n = data.length;

    if (n === 0) {
        throw new CobsError("empty frame");
    }

    const out: number[] = [];
    let i = 0;

    while (i < n) {
        const code = data[i];

        if (code === 0) {
            throw new CobsError("zero byte inside a frame");
        }

        const end = i + code;

        if (end > n) {
            throw new CobsError("code byte points past the end of the frame");
        }

        for (let j = i + 1; j < end; j++) {
            if (data[j] === 0) {
                throw new CobsError("zero byte inside a frame");
            }

            out.push(data[j]);
        }

        i = end;

        if (code !== 0xff && i < n) {
            out.push(0);
        }
    }

    return Buffer.from(out);
}

export enum BadFrame {
    TooLong = 1,
    Cobs = 2,
    LineError = 3,
}

/** Collects bytes up to a `0x00` delimiter (mirrors `zigbee-zrhp`). */
export class CobsAccumulator {
    #buf: number[] = [];
    #discarding = false;
    readonly #limit: number;

    constructor(limit = MAX_ENCODED_FRAME) {
        this.#limit = limit;
    }

    reset(): void {
        this.#buf = [];
        this.#discarding = false;
    }

    /** Abort the current frame after a UART framing/parity/overrun error. */
    lineError(): BadFrame {
        this.#buf = [];
        this.#discarding = true;

        return BadFrame.LineError;
    }

    /** Feed one byte. Returns a decoded frame, a {@link BadFrame} or `undefined`. */
    push(byte: number): Buffer | BadFrame | undefined {
        if (byte === 0) {
            const buf = this.#buf;
            const discarding = this.#discarding;
            this.#buf = [];
            this.#discarding = false;

            if (discarding || buf.length === 0) {
                return undefined;
            }

            try {
                return cobsDecode(Uint8Array.from(buf));
            } catch {
                return BadFrame.Cobs;
            }
        }

        if (this.#discarding) {
            return undefined;
        }

        if (this.#buf.length >= this.#limit) {
            this.#buf = [];
            this.#discarding = true;

            return BadFrame.TooLong;
        }

        this.#buf.push(byte);

        return undefined;
    }
}

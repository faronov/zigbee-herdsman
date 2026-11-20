/**
 * Little-endian wire primitives and a small declarative struct layer for ZRHP messages and records.
 *
 * Every field type is a {@link Codec}; {@link struct} composes them in declaration order, so structs nest (lists of structs,
 * records inside messages). Decoders ignore trailing bytes (spec 6.6 minor-version rule).
 */

export class CodecError extends Error {}

export class Writer {
    readonly parts: Buffer[] = [];

    bytes(b: Uint8Array): void {
        this.parts.push(Buffer.from(b));
    }

    u8(v: number): void {
        if (!Number.isInteger(v) || v < 0 || v > 0xff) {
            throw new CodecError(`u8 out of range: ${v}`);
        }

        this.parts.push(Buffer.from([v]));
    }

    i8(v: number): void {
        if (!Number.isInteger(v) || v < -128 || v > 127) {
            throw new CodecError(`i8 out of range: ${v}`);
        }

        this.parts.push(Buffer.from([v & 0xff]));
    }

    u16(v: number): void {
        if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
            throw new CodecError(`u16 out of range: ${v}`);
        }

        const b = Buffer.alloc(2);
        b.writeUInt16LE(v);
        this.parts.push(b);
    }

    u32(v: number): void {
        if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
            throw new CodecError(`u32 out of range: ${v}`);
        }

        const b = Buffer.alloc(4);
        b.writeUInt32LE(v);
        this.parts.push(b);
    }

    u64(v: bigint): void {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(v);
        this.parts.push(b);
    }

    toBuffer(): Buffer {
        return Buffer.concat(this.parts);
    }
}

export class Reader {
    readonly buf: Buffer;
    offset: number;

    constructor(buf: Buffer, offset = 0) {
        this.buf = buf;
        this.offset = offset;
    }

    get remaining(): number {
        return this.buf.length - this.offset;
    }

    private need(n: number): number {
        const at = this.offset;

        if (at + n > this.buf.length) {
            throw new CodecError("truncated");
        }

        this.offset += n;

        return at;
    }

    u8(): number {
        return this.buf[this.need(1)];
    }

    i8(): number {
        return this.buf.readInt8(this.need(1));
    }

    u16(): number {
        return this.buf.readUInt16LE(this.need(2));
    }

    u32(): number {
        return this.buf.readUInt32LE(this.need(4));
    }

    u64(): bigint {
        return this.buf.readBigUInt64LE(this.need(8));
    }

    bytes(n: number): Buffer {
        const at = this.need(n);

        return Buffer.from(this.buf.subarray(at, at + n));
    }

    rest(): Buffer {
        return this.bytes(this.remaining);
    }
}

export interface Codec<T> {
    write(w: Writer, v: T): void;
    read(r: Reader): T;
    def(): T;
}

export const u8: Codec<number> = {write: (w, v) => w.u8(v), read: (r) => r.u8(), def: () => 0};
export const i8: Codec<number> = {write: (w, v) => w.i8(v), read: (r) => r.i8(), def: () => 0};
export const u16: Codec<number> = {write: (w, v) => w.u16(v), read: (r) => r.u16(), def: () => 0};
export const u32: Codec<number> = {write: (w, v) => w.u32(v), read: (r) => r.u32(), def: () => 0};
export const u64: Codec<bigint> = {write: (w, v) => w.u64(v), read: (r) => r.u64(), def: () => 0n};

/** A fixed-size byte array (IEEE addresses travel in on-air order). */
export function fixed(size: number): Codec<Buffer> {
    return {
        write: (w, v) => {
            if (v.length !== size) {
                throw new CodecError(`expected ${size} bytes, got ${v.length}`);
            }

            w.bytes(v);
        },
        read: (r) => r.bytes(size),
        def: () => Buffer.alloc(size),
    };
}

export const ieee = fixed(8);
export const key16 = fixed(16);
export const epid = fixed(8);
export const sha256 = fixed(32);

/** `u8`-length-prefixed bytes. */
export const lv8: Codec<Buffer> = {
    write: (w, v) => {
        w.u8(v.length);
        w.bytes(v);
    },
    read: (r) => r.bytes(r.u8()),
    def: () => Buffer.alloc(0),
};

/** `u16`-length-prefixed bytes. */
export const lv16: Codec<Buffer> = {
    write: (w, v) => {
        w.u16(v.length);
        w.bytes(v);
    },
    read: (r) => r.bytes(r.u16()),
    def: () => Buffer.alloc(0),
};

/** The remainder of the payload. */
export const rest: Codec<Buffer> = {write: (w, v) => w.bytes(v), read: (r) => r.rest(), def: () => Buffer.alloc(0)};

/** A `u8`-counted list. */
export function listOf<T>(item: Codec<T>): Codec<T[]> {
    return {
        write: (w, v) => {
            w.u8(v.length);

            for (const x of v) {
                item.write(w, x);
            }
        },
        read: (r) => {
            const n = r.u8();
            const out: T[] = [];

            for (let i = 0; i < n; i++) {
                out.push(item.read(r));
            }

            return out;
        },
        def: () => [],
    };
}

// biome-ignore lint/suspicious/noExplicitAny: codec variance (fields of any value type)
export type Fields = Record<string, Codec<any>>;
export type StructOf<F extends Fields> = {[K in keyof F]: F[K] extends Codec<infer T> ? T : never};

export interface StructCodec<F extends Fields> extends Codec<StructOf<F>> {
    readonly fields: F;
    /** A value with every field at its default, overridden by `v`. */
    make(v?: Partial<StructOf<F>>): StructOf<F>;
    encode(v: Partial<StructOf<F>>): Buffer;
    decode(b: Buffer): StructOf<F>;
}

/** Compose `fields` in declaration order. */
export function struct<F extends Fields>(fields: F): StructCodec<F> {
    const names = Object.keys(fields) as (keyof F & string)[];
    const make = (v: Partial<StructOf<F>> = {}): StructOf<F> => {
        const out = {} as StructOf<F>;

        for (const n of names) {
            out[n] = (v[n] !== undefined ? v[n] : fields[n].def()) as StructOf<F>[typeof n];
        }

        return out;
    };
    const codec: StructCodec<F> = {
        fields,
        make,
        write: (w, v) => {
            for (const n of names) {
                fields[n].write(w, v[n]);
            }
        },
        read: (r) => {
            const out = {} as StructOf<F>;

            for (const n of names) {
                out[n] = fields[n].read(r) as StructOf<F>[typeof n];
            }

            return out;
        },
        def: () => make(),
        encode: (v) => {
            const w = new Writer();
            codec.write(w, make(v));

            return w.toBuffer();
        },
        decode: (b) => codec.read(new Reader(b)),
    };

    return codec;
}

export function encodeWith<T>(codec: Codec<T>, v: T): Buffer {
    const w = new Writer();
    codec.write(w, v);

    return w.toBuffer();
}

export function decodeWith<T>(codec: Codec<T>, b: Buffer): T {
    return codec.read(new Reader(b));
}

/** Zigbee AES-MMO hash and keyed hash (install codes, EZSP hashed TCLK). */

import {createCipheriv} from "node:crypto";

function aesEcb(key: Buffer, block: Buffer): Buffer {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(false);

    return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** Matyas-Meyer-Oseas hash with AES-128 and Zigbee padding (B.6). */
export function aesMmo(data: Buffer): Buffer {
    const n = data.length;
    const parts: number[] = [...data, 0x80];

    if (n < 2 ** 16 / 8) {
        while ((parts.length + 2) % 16) {
            parts.push(0);
        }

        parts.push(((n * 8) >> 8) & 0xff, (n * 8) & 0xff);
    } else {
        /* v8 ignore start */
        while ((parts.length + 6) % 16) {
            parts.push(0);
        }

        const bits = n * 8;
        parts.push((bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff, 0, 0);
        /* v8 ignore stop */
    }

    const padded = Buffer.from(parts);
    let h = Buffer.alloc(16);

    for (let i = 0; i < padded.length; i += 16) {
        const block = padded.subarray(i, i + 16);
        const enc = aesEcb(h, block);
        h = Buffer.from(enc.map((b, j) => b ^ block[j]));
    }

    return h;
}

/** Zigbee keyed hash (HMAC with AES-MMO, 16-byte block). */
export function hmacMmo(key: Buffer, message: Buffer): Buffer {
    const ipad = Buffer.from(key.map((k) => k ^ 0x36));
    const opad = Buffer.from(key.map((k) => k ^ 0x5c));

    return aesMmo(Buffer.concat([opad, aesMmo(Buffer.concat([ipad, message]))]));
}

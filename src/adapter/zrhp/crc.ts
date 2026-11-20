/**
 * CRC-32C (Castagnoli), ZRHP spec 5.2.
 *
 * Reflected polynomial `0x82F63B78`, init `0xFFFFFFFF`, xorout `0xFFFFFFFF`.
 * The check value of `"123456789"` is `0xE3069283`.
 */

const POLY = 0x82f63b78;

const TABLE = (() => {
    const table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
        let crc = i;

        for (let j = 0; j < 8; j++) {
            crc = crc & 1 ? (crc >>> 1) ^ POLY : crc >>> 1;
        }

        table[i] = crc >>> 0;
    }

    return table;
})();

/** CRC-32C of `data`; `crc` continues a previous result. */
export function crc32c(data: Uint8Array, crc = 0): number {
    let c = (crc ^ 0xffffffff) >>> 0;

    for (let i = 0; i < data.length; i++) {
        c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }

    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Open ZigBee Coordinator Backup (OCB) <-> ZRHP records (spec 9.1-9.3).
 *
 * Host-side converters of `host-protocol-vectors/generate.py`, with the importer tolerances of spec 9.1 (Z2M unpadded hex,
 * `date`, missing TCLK counter, pass-through of unknown `internal`/`stack_specific` keys). A port of `zigpy_zrhp/ocb.py`.
 */

import {FC_STRIDE} from "./consts";
import {
    DeviceFlags,
    type DeviceRecordValue,
    decodeRecordValue,
    encodeRecord,
    encodeRecordValue,
    endRecord,
    KeyAttrs,
    KeyOrigin,
    RecordType,
    type ZrhpRecord,
} from "./records";

export const TCLK_DEFAULT = Buffer.from("ZigBeeAlliance09");
/** Host APS margin when a backup carries no APS frame counter information (spec 9.4). */
export const APS_UNKNOWN_TCLK_MARGIN = 1 << 20;
/** APS margin when the counter is known (spec 9.4 rule 6). */
export const APS_KNOWN_MARGIN = 10_000;
export const OCB_FORMAT = "zigpy/open-coordinator-backup";

/** Child-info defaults when OCB has no capability (spec 9.3). */
const DEFAULT_CHILD_CAPABILITY = 0x80;
const DEFAULT_CHILD_TIMEOUT_EXP = 8;

/** `internal` keys this converter interprets; others are passed through. */
const KNOWN_INTERNAL = new Set(["node", "network", "link_key_seqs", "creation_time", "date", "route_table", "tx_power"]);

// biome-ignore lint/suspicious/noExplicitAny: free-form JSON
export type Json = any;

/** OCB big-endian hex -> on-air (little-endian) bytes. */
export function ieeeWire(text: string): Buffer {
    return Buffer.from(text.replaceAll(":", "").replace(/^0x/, "").padStart(16, "0"), "hex").reverse();
}

/** On-air bytes -> OCB big-endian hex. */
export function ieeeText(raw: Buffer): string {
    return Buffer.from(raw).reverse().toString("hex");
}

/** A big-endian 16-bit hex field; Z2M omits leading zeros (`"a62"`). */
export function hex16(text: string): number {
    return Number.parseInt(text.padStart(4, "0"), 16);
}

export function channelsToMask(channels: number[]): number {
    let mask = 0;

    for (const c of channels) {
        if (c < 11 || c > 26) {
            throw new Error(`invalid channel ${c}`);
        }

        mask |= 1 << c;
    }

    return mask >>> 0;
}

export function maskToChannels(mask: number): number[] {
    const out: number[] = [];

    for (let c = 11; c <= 26; c++) {
        if (mask & (1 << c)) {
            out.push(c);
        }
    }

    return out;
}

/** `false` for backups without a TCLK frame counter (Z2M, spec 9.1). */
export function tclkCounterKnown(ocb: Json): boolean {
    const tclk = ocb?.metadata?.internal?.network?.tc_link_key;

    return tclk !== null && typeof tclk === "object" && "frame_counter" in tclk;
}

/**
 * `[nwkMargin, apsMargin]` for a restore of `ocb` (spec 9.4 rule 6).
 *
 * The APS counter is known when the backup has a TCLK frame counter or a `stack_specific.zigbee_rs` APS limit (12.1.1 Z5);
 * otherwise (plain Z2M backups) the margin is 2^20.
 */
export function restoreMargins(ocb: Json, nwkMargin = 0): [number, number] {
    const zrs = ocb?.stack_specific?.zigbee_rs;
    const known = tclkCounterKnown(ocb) || typeof zrs?.aps_frame_counter_limit === "number";

    return [nwkMargin, known ? APS_KNOWN_MARGIN : APS_UNKNOWN_TCLK_MARGIN];
}

/** Convert an OCB backup into restore records, ending with `END`. `nodeFlags` bit0 marks the coordinator IEEE as an override. */
export function ocbToRecords(ocb: Json, nodeFlags = 0x01): ZrhpRecord[] {
    const internal = ocb.metadata?.internal ?? {};
    const node = internal.node ?? {};
    const network = internal.network ?? {};
    const coordinator = ieeeWire(ocb.coordinator_ieee);
    const recs: ZrhpRecord[] = [
        {type: RecordType.NODE, value: {ieee: coordinator, nwk: hex16(node.nwk ?? "0000"), logicalType: 0, flags: nodeFlags}},
    ];
    let txPower: number | undefined = internal.tx_power;

    if (txPower != null) {
        txPower = Math.max(-128, Math.min(126, Math.round(Number(txPower))));
    }

    recs.push({
        type: RecordType.NETWORK,
        value: {
            panId: hex16(String(ocb.pan_id)),
            extPanId: ieeeWire(ocb.extended_pan_id),
            channel: ocb.channel,
            channelMask: channelsToMask(ocb.channel_mask),
            nwkUpdateId: ocb.nwk_update_id ?? 0,
            nwkManager: hex16(network.nwk_manager ?? "0000"),
            securityLevel: ocb.security_level ?? 5,
            txPower: txPower == null ? 0x7f : txPower,
        },
    });

    const key = ocb.network_key;
    recs.push({
        type: RecordType.NETWORK_KEY,
        value: {key: Buffer.from(key.key, "hex"), seq: key.sequence_number || 0, txCounter: key.frame_counter || 0, flags: 0x01},
    });

    const tclk = network.tc_link_key;
    const tcKey = tclk ? Buffer.from(tclk.key, "hex") : TCLK_DEFAULT;
    const tcCounter = tclk ? tclk.frame_counter || 0 : 0;
    let tcAddress = network.tc_address ? ieeeWire(network.tc_address) : coordinator;

    if (tcAddress.equals(Buffer.alloc(8, 0xff)) || tcAddress.equals(Buffer.alloc(8))) {
        tcAddress = coordinator;
    }

    const stackSpecific = ocb.stack_specific ?? {};
    const hashed: string | undefined = stackSpecific.ezsp?.hashed_tclk;
    recs.push({type: RecordType.TC_LINK_KEY, value: {key: tcKey, tcIeee: tcAddress, txCounter: tcCounter, flags: hashed ? 0x01 : 0x00}});

    if (hashed) {
        recs.push({type: RecordType.EZSP_HASHED_TCLK, value: {seed: Buffer.from(hashed, "hex")}});
    }

    const zrs = stackSpecific.zigbee_rs;

    if (zrs) {
        recs.push({
            type: RecordType.RS_PARAMS,
            value: {
                fcStride: zrs.frame_counter_stride ?? FC_STRIDE,
                tableEpoch: zrs.table_epoch ?? 0,
                nwkFcLimit: zrs.nwk_frame_counter_limit ?? 0,
                apsFcLimit: zrs.aps_frame_counter_limit ?? 0,
                flags: zrs.host_backed_tables ? 0x01 : 0x00,
            },
        });
    }

    const seqs: Record<string, number> = {};

    for (const [k, v] of Object.entries(internal.link_key_seqs ?? {})) {
        seqs[k.toLowerCase()] = v as number;
    }

    const devices = [...(ocb.devices ?? [])].sort((a: Json, b: Json) => cmp(a.ieee_address.toLowerCase(), b.ieee_address.toLowerCase()));

    for (const dev of devices) {
        recs.push({type: RecordType.DEVICE, value: deviceRecord(dev, seqs)});
    }

    if (zrs) {
        for (const value of zrs.gp_proxy_table ?? []) {
            recs.push(decodeRecordValue(RecordType.GP_PROXY, Buffer.from(value, "hex")));
        }

        for (const value of zrs.gp_sink_table ?? []) {
            recs.push(decodeRecordValue(RecordType.GP_SINK, Buffer.from(value, "hex")));
        }
    }

    recs.push(endRecord(recs.map(encodeRecord)));

    return recs;
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function deviceRecord(dev: Json, seqs: Record<string, number>): DeviceRecordValue {
    const ieee = String(dev.ieee_address).toLowerCase();
    const nwkText: string | null | undefined = dev.nwk_address;
    const nwk = nwkText == null ? undefined : hex16(nwkText);
    const isChild = dev.is_child ?? true;
    const out: DeviceRecordValue = {
        ieee: ieeeWire(ieee),
        nwk: nwk ?? 0xffff,
        flags: (isChild ? DeviceFlags.IS_CHILD : 0) | (nwk !== undefined ? DeviceFlags.NWK_VALID : 0),
    };

    if (isChild) {
        out.child = {capability: dev.capability ?? DEFAULT_CHILD_CAPABILITY, timeoutExp: dev.timeout_exp ?? DEFAULT_CHILD_TIMEOUT_EXP};
    }

    if (dev.link_key) {
        const lk = dev.link_key;
        out.link = {
            key: Buffer.from(lk.key, "hex"),
            keySeq: seqs[ieee] ?? 0,
            attrs: KeyAttrs.VERIFIED,
            origin: KeyOrigin.IMPORTED,
            txCounter: lk.tx_counter || 0,
            rxFloor: lk.rx_counter || 0,
        };
    }

    return out;
}

export interface RecordsToOcbOptions {
    source: string;
    creationTime: string;
    passthroughStackSpecific?: Json;
    passthroughInternal?: Json;
}

/** Convert exported records into an OCB backup (`END` is checked). */
export function recordsToOcb(records: ZrhpRecord[], options: RecordsToOcbOptions): Json {
    const end = records.at(-1);

    if (end?.type !== RecordType.END) {
        throw new Error("record stream does not end with END");
    }

    const body = records.slice(0, -1);
    const expect = endRecord(body.map(encodeRecord));

    if (expect.type !== RecordType.END || expect.value.recordCount !== end.value.recordCount || expect.value.crc32c !== end.value.crc32c) {
        throw new Error("END record count or CRC mismatch");
    }

    const stackSpecific: Json = structuredClone(options.passthroughStackSpecific ?? {});
    const devices: Json[] = [];
    const seqs: Record<string, number> = {};
    const out: Json = {};
    let tclk: Json = {key: TCLK_DEFAULT.toString("hex"), frame_counter: 0};
    let tcAddress: string | undefined;
    let nodeNwk = 0;
    let txPower = 0x7f;
    const gpProxy: string[] = [];
    const gpSink: string[] = [];
    let zrs: Json;

    for (const rec of body) {
        switch (rec.type) {
            case RecordType.NODE:
                out.coordinator_ieee = ieeeText(rec.value.ieee);
                nodeNwk = rec.value.nwk;
                break;
            case RecordType.NETWORK:
                out.pan_id = rec.value.panId.toString(16).padStart(4, "0");
                out.extended_pan_id = ieeeText(rec.value.extPanId);
                out.channel = rec.value.channel;
                out.channel_mask = maskToChannels(rec.value.channelMask);
                out.nwk_update_id = rec.value.nwkUpdateId;
                out.security_level = rec.value.securityLevel;
                txPower = rec.value.txPower;
                break;
            case RecordType.NETWORK_KEY:
                out.network_key = {key: rec.value.key.toString("hex"), sequence_number: rec.value.seq, frame_counter: rec.value.txCounter};
                break;
            case RecordType.TC_LINK_KEY:
                tclk = {key: rec.value.key.toString("hex"), frame_counter: rec.value.txCounter};
                tcAddress = ieeeText(rec.value.tcIeee);
                break;
            case RecordType.EZSP_HASHED_TCLK:
                stackSpecific.ezsp = {...(stackSpecific.ezsp ?? {}), hashed_tclk: rec.value.seed.toString("hex")};
                break;
            case RecordType.RS_PARAMS:
                zrs = {
                    version: 1,
                    frame_counter_stride: rec.value.fcStride,
                    table_epoch: rec.value.tableEpoch,
                    nwk_frame_counter_limit: rec.value.nwkFcLimit,
                    aps_frame_counter_limit: rec.value.apsFcLimit,
                    host_backed_tables: (rec.value.flags & 0x01) !== 0,
                };
                break;
            case RecordType.DEVICE: {
                const ieee = ieeeText(rec.value.ieee);
                const dev: Json = {
                    ieee_address: ieee,
                    nwk_address: rec.value.flags & DeviceFlags.NWK_VALID ? rec.value.nwk.toString(16).padStart(4, "0") : null,
                    is_child: (rec.value.flags & DeviceFlags.IS_CHILD) !== 0,
                };

                if (rec.value.link) {
                    dev.link_key = {
                        key: rec.value.link.key.toString("hex"),
                        tx_counter: rec.value.link.txCounter,
                        rx_counter: rec.value.link.rxFloor,
                    };
                    seqs[ieee] = rec.value.link.keySeq;
                }

                devices.push(dev);
                break;
            }
            case RecordType.GP_PROXY:
                gpProxy.push(encodeRecordValue(rec).toString("hex"));
                break;
            case RecordType.GP_SINK:
                gpSink.push(encodeRecordValue(rec).toString("hex"));
                break;
            default:
                // SOURCE_ROUTE, GP_TRANSLATION and unknown records have no OCB field.
                break;
        }
    }

    if (out.network_key === undefined) {
        // Key export locked: an incomplete backup.
        out.network_key = {key: "ff".repeat(16), sequence_number: 0, frame_counter: zrs ? zrs.nwk_frame_counter_limit : 0};
    }

    if (zrs !== undefined) {
        zrs.gp_proxy_table = gpProxy;
        zrs.gp_sink_table = gpSink;
        stackSpecific.zigbee_rs = zrs;
    }

    const internal: Json = {
        creation_time: options.creationTime,
        node: {ieee: out.coordinator_ieee, nwk: nodeNwk.toString(16).padStart(4, "0"), type: "coordinator"},
        network: {tc_link_key: tclk, tc_address: tcAddress ?? out.coordinator_ieee, nwk_manager: "0000"},
        link_key_seqs: seqs,
    };

    if (txPower !== 0x7f) {
        internal.tx_power = txPower;
    }

    for (const [k, v] of Object.entries(options.passthroughInternal ?? {})) {
        if (!KNOWN_INTERNAL.has(k)) {
            internal[k] = structuredClone(v);
        }
    }

    return {
        metadata: {version: 1, format: OCB_FORMAT, source: options.source, internal},
        stack_specific: stackSpecific,
        coordinator_ieee: out.coordinator_ieee,
        pan_id: out.pan_id,
        extended_pan_id: out.extended_pan_id,
        nwk_update_id: out.nwk_update_id,
        security_level: out.security_level,
        channel: out.channel,
        channel_mask: out.channel_mask,
        network_key: out.network_key,
        devices: devices.sort((a, b) => cmp(a.ieee_address, b.ieee_address)),
    };
}

/** Unknown `metadata.internal` keys to re-emit unchanged (spec 9.1). */
export function passthroughInternal(ocb: Json): Json {
    const internal = ocb?.metadata?.internal ?? {};

    return Object.fromEntries(Object.entries(internal).filter(([k]) => !KNOWN_INTERNAL.has(k)));
}

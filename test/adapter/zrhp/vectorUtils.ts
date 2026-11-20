import {readFileSync} from "node:fs";
import {join} from "node:path";
import {RecordType, type ZrhpRecord} from "../../../src/adapter/zrhp/records";

// biome-ignore lint/suspicious/noExplicitAny: JSON vectors
export type Json = any;

/** A shared vector file (copied from `zigbee-rs/docs/book/src/advanced/host-protocol-vectors`). */
export function loadVector(name: string): Json {
    return JSON.parse(readFileSync(join(__dirname, "vectors", name), "utf8"));
}

/** The restore counter rules of spec 9.4 rule 4 (the NCP model of `generate.py`). */
export function applyRestore(recs: ZrhpRecord[], nwkMargin: number, apsMargin: number): {nwkFcStart: number; apsFcStart: number} {
    let nwk = 0;
    let aps = 0;

    for (const r of recs) {
        if (r.type === RecordType.NETWORK_KEY) {
            nwk = Math.max(nwk, r.value.txCounter);
        } else if (r.type === RecordType.RS_PARAMS) {
            nwk = Math.max(nwk, r.value.nwkFcLimit);
            aps = Math.max(aps, r.value.apsFcLimit);
        } else if (r.type === RecordType.TC_LINK_KEY) {
            aps = Math.max(aps, r.value.txCounter);
        } else if (r.type === RecordType.DEVICE && r.value.link) {
            aps = Math.max(aps, r.value.link.txCounter);
        }
    }

    return {nwkFcStart: nwk + nwkMargin, apsFcStart: aps + apsMargin};
}

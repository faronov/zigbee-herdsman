/**
 * Host store of the herdsman ZRHP adapter (spec 8.8, 12.3): an append-only JSON-lines sidecar file next to `database.db`.
 *
 * Each line is one record (`meta`, `key`, `delkey`, `fc`, `clear`) and is fsync'ed before the call returns, so a writeback is
 * acknowledged to the NCP only after a durable commit. The file is compacted when it is opened.
 */

import {closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync} from "node:fs";
import {logger} from "../../utils/logger";

const NS = "zh:zrhp:store";

export interface LinkKeyRow {
    /** on-air IEEE hex */
    ieee: string;
    key?: string;
    attrs: number;
    origin: number;
    keySeq: number;
    rxFloor: number;
    rev: number;
    nwk?: number;
}

export interface StoreMeta {
    ncpIeee?: string;
    tableEpoch?: number;
    hostDbEpoch?: number;
    hostMaxRev?: number;
    lastNcpCookie?: number;
    /** `stack_specific` sections and `metadata.internal` keys of the last restored backup that the NCP does not hold */
    passthrough?: {stackSpecific?: Record<string, unknown>; internal?: Record<string, unknown>};
}

interface Checkpoint {
    domain: number;
    keySeq: number;
    limit: number;
    generation: number;
    time: string;
}

type Line = {t: "meta"; v: StoreMeta} | {t: "key"; v: LinkKeyRow} | {t: "delkey"; ieee: string} | {t: "fc"; v: Checkpoint} | {t: "clear"};

export class SidecarStore {
    readonly path: string;
    meta: StoreMeta = {};
    readonly keys = new Map<string, LinkKeyRow>();
    /** last durable limit per domain (1 NWK, 2 APS) */
    readonly checkpoints = new Map<number, Checkpoint>();
    #fd: number | undefined;

    constructor(path: string) {
        this.path = path;
    }

    open(): void {
        if (existsSync(this.path)) {
            for (const [i, text] of readFileSync(this.path, "utf8").split("\n").entries()) {
                if (!text.trim()) {
                    continue;
                }

                try {
                    this.apply(JSON.parse(text) as Line);
                } catch {
                    // A torn last line after a power cut; anything before it was committed.
                    logger.warning(`Ignoring unreadable line ${i + 1} of ${this.path}`, NS);
                }
            }
        }

        this.compact();
    }

    close(): void {
        if (this.#fd !== undefined) {
            closeSync(this.#fd);
            this.#fd = undefined;
        }
    }

    private apply(line: Line): void {
        switch (line.t) {
            case "meta":
                this.meta = {...this.meta, ...line.v};
                break;
            case "key": {
                const old = this.keys.get(line.v.ieee);

                // I4: ignore stale writebacks; keep the highest replay floor (I3).
                if (!old || line.v.rev === 0 || line.v.rev > old.rev || old.rev === 0) {
                    this.keys.set(line.v.ieee, {...line.v, rxFloor: Math.max(line.v.rxFloor, old?.rxFloor ?? 0)});
                } else if (line.v.rxFloor > old.rxFloor) {
                    old.rxFloor = line.v.rxFloor;
                }

                break;
            }
            case "delkey":
                this.keys.delete(line.ieee);
                break;
            case "fc": {
                const old = this.checkpoints.get(line.v.domain);

                if (!old || line.v.limit >= old.limit) {
                    this.checkpoints.set(line.v.domain, line.v);
                }

                break;
            }
            case "clear":
                this.keys.clear();
                this.checkpoints.clear();
                this.meta = {ncpIeee: this.meta.ncpIeee, lastNcpCookie: this.meta.lastNcpCookie, hostDbEpoch: (this.meta.hostDbEpoch ?? 0) + 1};
                break;
        }
    }

    private lines(): Line[] {
        return [
            {t: "meta", v: this.meta},
            ...[...this.keys.values()].map((v): Line => ({t: "key", v})),
            ...[...this.checkpoints.values()].map((v): Line => ({t: "fc", v})),
        ];
    }

    /** Rewrite the file with the current state (atomic rename). */
    compact(): void {
        this.close();
        const tmp = `${this.path}.tmp`;
        const fd = openSync(tmp, "w");

        try {
            writeSync(
                fd,
                `${this.lines()
                    .map((l) => JSON.stringify(l))
                    .join("\n")}\n`,
            );
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }

        renameSync(tmp, this.path);
        this.#fd = openSync(this.path, "a");
    }

    private append(line: Line): void {
        this.apply(line);

        if (this.#fd === undefined) {
            this.#fd = openSync(this.path, "a");
        }

        writeSync(this.#fd, `${JSON.stringify(line)}\n`);
        fsyncSync(this.#fd);
    }

    setMeta(v: StoreMeta): void {
        this.append({t: "meta", v});
    }

    upsertKey(row: LinkKeyRow): void {
        this.append({t: "key", v: row});

        if (row.rev > (this.meta.hostMaxRev ?? 0)) {
            this.append({t: "meta", v: {hostMaxRev: row.rev}});
        }
    }

    deleteKey(ieee: string): void {
        this.append({t: "delkey", ieee});
    }

    addCheckpoint(domain: number, keySeq: number, limit: number, generation: number): void {
        this.append({t: "fc", v: {domain, keySeq, limit, generation, time: new Date().toISOString()}});
    }

    /** A new or restored network: keys and checkpoints of the old one no longer apply. */
    clearNetwork(): void {
        this.append({t: "clear"});
    }

    lastLimit(domain: number): number {
        return this.checkpoints.get(domain)?.limit ?? 0;
    }

    /** `NWK_INIT` floors: the last logged limit + 9 strides (spec 8.4), 0 without a log. */
    floors(stride: number): [nwk: number, aps: number] {
        const f = (d: number): number => {
            const c = this.checkpoints.get(d);

            return c ? Math.min(0xffffffff, c.limit + 9 * stride) : 0;
        };

        return [f(1), f(2)];
    }
}

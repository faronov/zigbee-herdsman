/** The adapter against the Rust NCP simulator (`apps/ncp-coordinator` example `ncp_sim`, spec 14.3). */

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {ZrhpAdapter, type ZrhpConfig} from "../../../src/adapter/zrhp/adapter/zrhpAdapter";
import {NcpCaps} from "../../../src/adapter/zrhp/consts";
import * as M from "../../../src/adapter/zrhp/messages";
import {BackupUtils} from "../../../src/utils";
import * as ZSpec from "../../../src/zspec";
import * as Zcl from "../../../src/zspec/zcl";
import * as Zdo from "../../../src/zspec/zdo";
import {NCP_SIM, ProcessPort, SimHolder} from "./ports";

const SIM_IEEE = "0x8070605040302010";
const KEY = [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13];
const EPID = [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0x01];

function netOpts(panID = 0x1a62, channel = 15) {
    return {panID, extendedPanID: EPID, channelList: [channel], networkKey: KEY, networkKeyDistribute: false};
}

const CONFIG: Partial<ZrhpConfig> = {connectTimeoutMs: 5000, resumeBudgetMs: 3000, hardResetOnFailure: false, baudrateFallback: false};

class Rig {
    readonly dir: string;
    readonly holders: SimHolder[] = [];
    readonly adapters: ZrhpAdapter[] = [];

    constructor() {
        this.dir = mkdtempSync(join(tmpdir(), "zrhp-"));
    }

    get backupPath(): string {
        return join(this.dir, "coordinator_backup.json");
    }

    adapter(holder: SimHolder, opts = netOpts(), force = false, mangle?: (d: Buffer) => Buffer): ZrhpAdapter {
        const a = new ZrhpAdapter(
            opts,
            {path: "/dev/null-zrhp", adapter: "zrhp"},
            this.backupPath,
            {disableLED: false, concurrent: 8, forceStartWithInconsistentAdapterConfiguration: force},
            {port: new ProcessPort(holder, mangle), config: CONFIG},
        );
        this.adapters.push(a);

        return a;
    }

    holder(): SimHolder {
        const h = new SimHolder();
        this.holders.push(h);

        return h;
    }

    async writeBackup(a: ZrhpAdapter, devices: string[] = []): Promise<Record<string, unknown>> {
        const unified = BackupUtils.toUnifiedBackup(await a.backup(devices));
        writeFileSync(this.backupPath, JSON.stringify(unified, null, 2));

        return JSON.parse(readFileSync(this.backupPath, "utf8"));
    }

    async cleanup(): Promise<void> {
        for (const a of this.adapters) {
            await a.stop().catch(() => undefined);
        }

        for (const h of this.holders) {
            await h.kill();
        }

        rmSync(this.dir, {recursive: true, force: true});
    }
}

if (process.env.ZRHP_REQUIRE_SIM && !NCP_SIM) {
    // CI of the fork: the Rust simulator tests must not be skipped silently
    throw new Error("ZRHP_REQUIRE_SIM is set but ZRHP_NCP_SIM is not");
}

describe.runIf(NCP_SIM)("ZRHP adapter against the Rust NCP simulator", () => {
    let rig: Rig;

    afterEach(async () => {
        await rig?.cleanup();
    });

    it("forms from the configuration, resumes it, and serves the coordinator ZDO locally", async () => {
        rig = new Rig();
        const h = rig.holder();
        const a = rig.adapter(h);
        expect(await a.start()).toStrictEqual("reset");
        const params = await a.getNetworkParameters();
        expect(params).toStrictEqual({panID: 0x1a62, extendedPanID: "0xdddddddddddddd01", channel: 15, nwkUpdateID: 0});
        expect(await a.getCoordinatorIEEE()).toStrictEqual(SIM_IEEE);
        const version = await a.getCoordinatorVersion();
        expect(version.type).toStrictEqual("zigbee-rs ZRHP");
        expect(String(version.meta.revision)).toMatch(/^ncp-sim\//);
        expect(await a.supportsBackup()).toStrictEqual(true);

        // coordinator interview as herdsman's controller does it: answered on the host (spec 7.4)
        const active = await a.sendZdo(
            SIM_IEEE,
            0,
            Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, 0),
            false,
        );
        expect(Zdo.Buffalo.checkStatus<Zdo.ClusterId.ACTIVE_ENDPOINTS_RESPONSE>(active)).toStrictEqual(true);
        expect(active[1]?.endpointList).toStrictEqual([1, 242]);
        const simple = await a.sendZdo(
            SIM_IEEE,
            0,
            Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, 0, 1),
            false,
        );
        expect(simple[1]?.profileId).toStrictEqual(ZSpec.HA_PROFILE_ID);
        const node = await a.sendZdo(
            SIM_IEEE,
            0,
            Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST, 0),
            false,
        );
        expect(node[1]?.logicalType).toStrictEqual(0);
        const lqi = await a.sendZdo(
            SIM_IEEE,
            0,
            Zdo.ClusterId.LQI_TABLE_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.LQI_TABLE_REQUEST, 0),
            false,
        );
        expect(lqi[0]).toStrictEqual(Zdo.Status.SUCCESS);

        await a.permitJoin(30);
        await a.permitJoin(0, 0x0000);
        // broadcast and groupcast are confirmed after the MAC transmission
        const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 9, "toggle", "genOnOff", {}, {});
        await a.sendZclFrameToAll(0xff, frame, 1, ZSpec.BroadcastAddress.RX_ON_WHEN_IDLE);
        await a.sendZclFrameToGroup(901, frame, 1);
        await a.stop();

        // the NCP stays powered while the host restarts: same network, `resumed`
        const b = rig.adapter(h);
        expect(await b.start()).toStrictEqual("resumed");
        expect(await b.getNetworkParameters()).toStrictEqual(params);
        await b.stop();
    }, 60_000);

    it("backs up with stack_specific.zigbee_rs and restores onto a factory-new NCP", async () => {
        rig = new Rig();
        const h1 = rig.holder();
        const a = rig.adapter(h1);
        expect(await a.start()).toStrictEqual("reset");
        const ocb = await rig.writeBackup(a);
        await a.stop();
        await h1.kill();
        const zrs = (ocb.stack_specific as Record<string, Record<string, number>>).zigbee_rs;
        expect(zrs.version).toStrictEqual(1);
        expect(zrs.nwk_frame_counter_limit).toBeGreaterThanOrEqual(1024);
        expect((ocb.metadata as Record<string, Record<string, unknown>>).internal.network).toBeDefined();
        expect(ocb.coordinator_ieee).toStrictEqual(SIM_IEEE.slice(2));
        expect(ocb.extended_pan_id).toStrictEqual("dddddddddddddd01");
        const nwkBefore = (ocb.network_key as Record<string, number>).frame_counter;

        // a factory-new NCP (new process) gets the backup restored
        const h2 = rig.holder();
        const b = rig.adapter(h2);
        expect(await b.start()).toStrictEqual("restored");
        expect(await b.getNetworkParameters()).toMatchObject({panID: 0x1a62, extendedPanID: "0xdddddddddddddd01", channel: 15});
        const [, fc] = await b.api.request(M.Id.SEC_GET_FRAME_COUNTERS, M.SecGetFrameCountersReq, {}, M.SecGetFrameCountersRsp);
        // counters only move forward: NWK +10 000; APS limit known from zigbee_rs, +10 000
        expect(fc?.nwkCurrent).toBeGreaterThanOrEqual(nwkBefore + 10_000);
        expect(fc?.apsCurrent).toBeGreaterThanOrEqual(zrs.aps_frame_counter_limit + 10_000);
        // the re-export keeps zigbee_rs and the herdsman round trip is stable
        const again = await rig.writeBackup(b);
        expect((again.stack_specific as Record<string, unknown>).zigbee_rs).toBeDefined();
        expect(again.pan_id).toStrictEqual(ocb.pan_id);
        await b.stop();
    }, 60_000);

    it("restores a plain Z2M backup (no TCLK counter) with the 2^20 APS margin", async () => {
        rig = new Rig();
        const z2m = {
            metadata: {
                format: "zigpy/open-coordinator-backup",
                version: 1,
                source: "zigbee-herdsman@11.2.0",
                internal: {date: "2026-11-02T08:00:00.000Z"},
            },
            stack_specific: {},
            coordinator_ieee: SIM_IEEE.slice(2),
            pan_id: "a62",
            extended_pan_id: "dddddddddddddd01",
            nwk_update_id: 0,
            security_level: 5,
            channel: 20,
            channel_mask: [20],
            network_key: {key: Buffer.from(KEY).toString("hex"), sequence_number: 0, frame_counter: 77000},
            devices: [
                {nwk_address: "abc", ieee_address: "000d6f000e1f2a3b", is_child: true},
                {
                    nwk_address: "1a2b",
                    ieee_address: "0017880102a1b2c3",
                    is_child: false,
                    link_key: {key: "11223344556677881122334455667788", rx_counter: 7, tx_counter: 5},
                },
            ],
        };
        writeFileSync(rig.backupPath, JSON.stringify(z2m));
        const a = rig.adapter(rig.holder(), netOpts(0x0a62, 20));
        expect(await a.start()).toStrictEqual("restored");
        const [, fc] = await a.api.request(M.Id.SEC_GET_FRAME_COUNTERS, M.SecGetFrameCountersReq, {}, M.SecGetFrameCountersRsp);
        expect(fc?.nwkCurrent).toBeGreaterThanOrEqual(87_000);
        expect(fc?.apsCurrent).toBeGreaterThanOrEqual(1_048_581);
        const out = await rig.writeBackup(a, ["0x0017880102a1b2c3", "0x000d6f000e1f2a3b"]);
        const devices = out.devices as {ieee_address: string; link_key?: {key: string}}[];
        expect(devices.map((d) => d.ieee_address).sort()).toStrictEqual(["000d6f000e1f2a3b", "0017880102a1b2c3"]);
        expect(devices.find((d) => d.ieee_address === "0017880102a1b2c3")?.link_key?.key).toStrictEqual("11223344556677881122334455667788");
        await a.stop();
    }, 60_000);

    it("refuses a configuration that matches neither the NCP nor its backup, unless forced", async () => {
        rig = new Rig();
        const h = rig.holder();
        const a = rig.adapter(h);
        expect(await a.start()).toStrictEqual("reset");
        await rig.writeBackup(a);
        await a.stop();
        const b = rig.adapter(h, netOpts(0x2222));
        await expect(b.start()).rejects.toThrow("configuration-adapter mismatch");
        await b.stop();
        const c = rig.adapter(h, netOpts(0x2222), true);
        expect(await c.start()).toStrictEqual("resumed");
        await c.stop();
        // a new configuration without a matching backup re-forms ("reset")
        rmSync(rig.backupPath);
        const d = rig.adapter(h, netOpts(0x3333));
        expect(await d.start()).toStrictEqual("reset");
        expect((await d.getNetworkParameters()).panID).toStrictEqual(0x3333);
        await d.stop();
    }, 60_000);

    it("survives a noisy line (bit errors in both directions)", async () => {
        rig = new Rig();
        let seed = 7;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        const noise = (d: Buffer): Buffer => {
            const out = Buffer.from(d);

            for (let i = 0; i < out.length; i++) {
                if (rand() < 2e-4) {
                    out[i] ^= 1 << Math.floor(rand() * 8);
                }
            }

            return out;
        };
        const a = rig.adapter(rig.holder(), netOpts(), false, noise);
        expect(await a.start()).toStrictEqual("reset");
        const results = await Promise.all(
            Array.from({length: 300}, async (_, i) => {
                const [, rsp] = await a.api.request(M.Id.SYS_ECHO, M.SysEchoReq, {data: Buffer.alloc(64, i)}, M.SysEchoRsp, {timeout: 30_000});
                return rsp?.data.equals(Buffer.alloc(64, i));
            }),
        );
        expect(results.every(Boolean)).toStrictEqual(true);
        const [, counters] = await a.api.request(M.Id.DIAG_GET_COUNTERS, M.DiagGetCountersReq, {groupMask: 0x01}, M.DiagGetCountersRsp);
        const ncp = new Map(counters?.counters.map((c) => [c.id, c.value]));
        expect(ncp.get(0x0113) ?? 0).toBeGreaterThan(0); // the Rust receiver saw (and recovered) bad frames
        expect(a.api.session?.hasCap(NcpCaps.BACKUP_RESTORE)).toStrictEqual(true);
        await a.stop();
    }, 90_000);

    it("reports a lost NCP that cannot be resumed (RAM-only simulator forgets its network)", async () => {
        rig = new Rig();
        const h = rig.holder();
        const a = rig.adapter(h);
        expect(await a.start()).toStrictEqual("reset");
        const disconnected = new Promise<void>((resolve) => a.once("disconnected", resolve));
        await h.kill();
        await disconnected;
    }, 60_000);
});

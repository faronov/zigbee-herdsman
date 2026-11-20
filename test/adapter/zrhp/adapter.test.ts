/** The ZRHP adapter against a scriptable NCP: events, data path, GP, install codes and seamless resume (spec 12.1, 12.3). */

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Adapter} from "../../../src/adapter/adapter";
import type {ZclPayload} from "../../../src/adapter/events";
import {ocbToHerdsmanBackup, ZrhpAdapter, type ZrhpConfig} from "../../../src/adapter/zrhp/adapter/zrhpAdapter";
import {Status} from "../../../src/adapter/zrhp/consts";
import * as M from "../../../src/adapter/zrhp/messages";
import {RecordType} from "../../../src/adapter/zrhp/records";
import {SidecarStore} from "../../../src/adapter/zrhp/store";
import {BackupUtils} from "../../../src/utils";
import * as ZSpec from "../../../src/zspec";
import type {Eui64} from "../../../src/zspec/tstypes";
import * as Zcl from "../../../src/zspec/zcl";
import * as Zdo from "../../../src/zspec/zdo";
import type * as ZdoTypes from "../../../src/zspec/zdo/definition/tstypes";
import {MockNcp, MockPort} from "./mockNcp";

const KEY = [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13];
const EPID = [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0x02];
const DEV_IEEE = "0x0102030405060708";
const DEV_ONAIR = Buffer.from("0807060504030201", "hex");
const CONFIG: Partial<ZrhpConfig> = {
    connectTimeoutMs: 2000,
    resumeBudgetMs: 1500,
    hardResetOnFailure: false,
    baudrateFallback: false,
    confirmTimeoutMs: 1000,
    channelChangeTimeoutMs: 300,
};

async function until(pred: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;

    while (!pred()) {
        if (Date.now() > end) {
            throw new Error("condition not reached");
        }

        await new Promise((r) => setTimeout(r, 5));
    }
}

describe("ZRHP adapter against a scriptable NCP", () => {
    let dir: string;
    let ncp: MockNcp;
    let port: MockPort;
    let adapter: ZrhpAdapter;

    const make = (config: Partial<ZrhpConfig> = {}, panID = 0x2b2b): ZrhpAdapter => {
        port = new MockPort(ncp);
        adapter = new ZrhpAdapter(
            {panID, extendedPanID: EPID, channelList: [25], networkKey: KEY, networkKeyDistribute: false},
            {path: "/dev/mock", adapter: "zrhp"},
            join(dir, "coordinator_backup.json"),
            {disableLED: false, concurrent: 16},
            {port, config: {...CONFIG, ...config}},
        );

        return adapter;
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zrhp-mock-"));
        ncp = new MockNcp();
    });

    afterEach(async () => {
        await adapter?.stop().catch(() => undefined);
        ncp.stop();
        rmSync(dir, {recursive: true, force: true});
    });

    it("forms, then emits deviceJoined after the key exchange and deviceLeave", async () => {
        make();
        expect(await adapter.start()).toStrictEqual("reset");
        const form = M.NwkFormReq.decode(ncp.last(M.Id.NWK_FORM)?.payload as Buffer);
        // herdsman's extendedPanID array is the OCB (big-endian) order; on air it is reversed
        expect(form.extPanId).toStrictEqual(Buffer.from(EPID).reverse());
        expect(form.channelMask).toStrictEqual(1 << 25);
        expect(ncp.count(M.Id.NWK_ADD_ENDPOINT)).toStrictEqual(1);
        expect(M.GpSinkConfigReq.decode(ncp.last(M.Id.GP_SINK_CONFIG)?.payload as Buffer).mode).toStrictEqual(0);
        expect(await adapter.getNetworkParameters()).toStrictEqual({panID: 0x2b2b, extendedPanID: "0xdddddddddddddd02", channel: 25, nwkUpdateID: 0});
        expect(await adapter.getCoordinatorIEEE()).toStrictEqual("0x8877665544332211");

        const joined = vi.fn();
        const left = vi.fn();
        adapter.on("deviceJoined", joined);
        adapter.on("deviceLeave", left);
        ncp.event(M.Id.EVT_DEVICE_JOINED, M.EvtDeviceJoined, {
            nwk: 0x1234,
            ieee: DEV_ONAIR,
            parentNwk: 0,
            joinType: 0,
            capability: 0x80,
            decision: 0,
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(joined).not.toHaveBeenCalled(); // waits for the key exchange
        ncp.event(M.Id.EVT_DEVICE_AUTHORIZED, M.EvtDeviceAuthorized, {nwk: 0x1234, ieee: DEV_ONAIR, result: 1, linkKeyType: 1});
        await until(() => joined.mock.calls.length === 1);
        expect(joined).toHaveBeenCalledWith({networkAddress: 0x1234, ieeeAddr: DEV_IEEE});
        // secured rejoin: immediate; denied: ignored
        ncp.event(M.Id.EVT_DEVICE_JOINED, M.EvtDeviceJoined, {
            nwk: 0x4321,
            ieee: DEV_ONAIR,
            parentNwk: 0,
            joinType: 1,
            capability: 0x8e,
            decision: 0,
        });
        ncp.event(M.Id.EVT_DEVICE_JOINED, M.EvtDeviceJoined, {
            nwk: 0x5555,
            ieee: Buffer.alloc(8, 9),
            parentNwk: 0,
            joinType: 0,
            capability: 0,
            decision: 1,
        });
        await until(() => joined.mock.calls.length === 2);
        expect(joined.mock.calls[1][0]).toStrictEqual({networkAddress: 0x4321, ieeeAddr: DEV_IEEE});
        ncp.event(M.Id.EVT_DEVICE_LEFT, M.EvtDeviceLeft, {nwk: 0x4321, ieee: DEV_ONAIR, flags: 0, reason: 1});
        ncp.event(M.Id.EVT_DEVICE_LEFT, M.EvtDeviceLeft, {nwk: 0x7777, ieee: Buffer.alloc(8), flags: 0, reason: 4});
        await until(() => left.mock.calls.length === 2);
        expect(left.mock.calls[0][0]).toStrictEqual({networkAddress: 0x4321, ieeeAddr: DEV_IEEE});
        expect(left.mock.calls[1][0]).toStrictEqual({networkAddress: 0x7777});
    });

    it("emits deviceJoined after the authorization timeout when no EVT_DEVICE_AUTHORIZED comes", async () => {
        make();
        await adapter.start();
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        const joined = vi.fn();
        adapter.on("deviceJoined", joined);

        try {
            ncp.event(M.Id.EVT_DEVICE_JOINED, M.EvtDeviceJoined, {
                nwk: 0x1234,
                ieee: DEV_ONAIR,
                parentNwk: 0,
                joinType: 2,
                capability: 0x80,
                decision: 0,
            });
            await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
            await vi.advanceTimersByTimeAsync(5100);
        } finally {
            vi.useRealTimers();
        }

        await until(() => joined.mock.calls.length === 1);
    });

    it("sends ZCL with APS ACK, matches the response, and parses reports, groupcasts and GP frames", async () => {
        make();
        await adapter.start();
        const payloads: ZclPayload[] = [];
        adapter.on("zclPayload", (p) => payloads.push(p));
        const frame = Zcl.Frame.create(
            Zcl.FrameType.GLOBAL,
            Zcl.Direction.CLIENT_TO_SERVER,
            false,
            undefined,
            42,
            "read",
            "genBasic",
            [{attrId: 5}],
            {},
        );
        // the device answers the read
        ncp.overrides.set(M.Id.APS_DATA_REQUEST, (req) => {
            const r = M.decodeMessage(req) as M.ApsDataRequestValue;
            setTimeout(() => {
                ncp.event(M.Id.EVT_APS_DATA_CONFIRM, M.EvtApsDataConfirm, {
                    reqTid: req.tid,
                    status: 0,
                    zbStatus: 0,
                    apsCounter: 1,
                    dstNwk: 0x1234,
                    flags: 1,
                    elapsedMs: 1,
                });

                if (r.profile === 0x0104) {
                    ncp.indicate({srcNwk: 0x1234, srcEp: 1, cluster: 0x0000, asdu: Buffer.from("182a01050000420141", "hex")});
                }
            }, 2);
            return Buffer.from([0]);
        });
        const rsp = await adapter.sendZclFrameToEndpoint(DEV_IEEE, 0x1234, 1, frame, 2000, false, false, 1);
        expect(rsp?.header?.transactionSequenceNumber).toStrictEqual(42);
        expect(rsp?.address).toStrictEqual(0x1234);
        const sent = M.decodeMessage(ncp.last(M.Id.APS_DATA_REQUEST) as M.Message) as M.ApsDataRequestValue;
        expect(sent).toMatchObject({dstMode: 2, dst: 0x1234, dstEp: 1, srcEp: 1, profile: 0x0104, cluster: 0, txOptions: 1});

        // report (unicast), groupcast, broadcast
        ncp.indicate({srcNwk: 0x1234, srcEp: 1, cluster: 0x0402, asdu: Buffer.from("18050a0000293409", "hex"), lqi: 180});
        ncp.indicate({dstMode: 1, dst: 901, srcNwk: 0x1234, cluster: 0x0006, asdu: Buffer.from("01070200", "hex")});
        ncp.indicate({dstMode: 0x0f, dst: 0xfffd, srcNwk: 0x1234, cluster: 0x0006, asdu: Buffer.from("01080200", "hex")});
        // GP notification from a proxy, HOST_SINK mode (spec 7.11): EP 242, GP profile
        const gp = Buffer.from("1103000000187998af2a2b0000002200ffff", "hex");
        ncp.indicate({dstMode: 0x0f, dst: 0xfffd, srcNwk: 0x4444, srcEp: 242, dstEp: 242, profile: 0xa1e0, cluster: 0x0021, asdu: gp});
        await until(() => payloads.length === 5);
        expect(payloads[1]).toMatchObject({
            clusterID: 0x0402,
            address: 0x1234,
            linkquality: 180,
            groupID: 0,
            wasBroadcast: false,
            destinationEndpoint: 1,
        });
        expect(payloads[2]).toMatchObject({groupID: 901, wasBroadcast: false});
        expect(payloads[3]).toMatchObject({wasBroadcast: true});
        expect(payloads[4]).toMatchObject({clusterID: 0x21, endpoint: 242, address: 0x4444});

        // herdsman's GP Proxy Commissioning Mode broadcast goes out with the GP profile from EP 242
        const gpFrame = Zcl.Frame.create(
            Zcl.FrameType.SPECIFIC,
            Zcl.Direction.SERVER_TO_CLIENT,
            true,
            undefined,
            7,
            "commisioningMode",
            "greenPower",
            {options: 0x0b, commisioningWindow: 180},
            {},
        );
        await adapter.sendZclFrameToAll(ZSpec.GP_ENDPOINT, gpFrame, ZSpec.GP_ENDPOINT, ZSpec.BroadcastAddress.RX_ON_WHEN_IDLE);
        expect(M.decodeMessage(ncp.last(M.Id.APS_DATA_REQUEST) as M.Message)).toMatchObject({
            dstMode: 0x0f,
            dst: 0xfffd,
            srcEp: 242,
            dstEp: 242,
            profile: 0xa1e0,
            cluster: 0x21,
        });
        await adapter.sendZclFrameToGroup(901, frame);
        expect(M.decodeMessage(ncp.last(M.Id.APS_DATA_REQUEST) as M.Message)).toMatchObject({dstMode: 1, dst: 901, nonMemberRadius: 3});
        // waitFor
        const w = adapter.waitFor(0x1234, 1, Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, 77, 0x0006, 0x0a, undefined, 2000);
        ncp.indicate({srcNwk: 0x1234, srcEp: 1, cluster: 0x0006, asdu: Buffer.from("184d0a00001001", "hex")});
        expect((await w.promise).header?.transactionSequenceNumber).toStrictEqual(0x4d);
        adapter.waitFor(0x1234, 1, Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, 78, 0x0006, 0x0a, undefined, 2000).cancel();
        // nothing is sent to the coordinator itself
        expect(await adapter.sendZclFrameToEndpoint("0x8877665544332211", 0, 1, frame, 100, true, true)).toBeUndefined();
    });

    it("retries a failed unicast once with route discovery, and retries BUSY", async () => {
        make();
        await adapter.start();
        ncp.apsResult.set(0x0bad, 0xa7);
        const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 3, "toggle", "genOnOff", {}, {});
        const before = ncp.count(M.Id.APS_DATA_REQUEST);
        await expect(adapter.sendZclFrameToEndpoint("0x01", 0x0bad, 1, frame, 1000, true, false)).rejects.toThrow("zb_status 0xa7");
        const reqs = ncp.requests.filter((r) => r.msgId === M.Id.APS_DATA_REQUEST).slice(before);
        expect(reqs.map((r) => (M.decodeMessage(r) as M.ApsDataRequestValue).txOptions)).toStrictEqual([0x01, 0x05]);
        await expect(adapter.sendZclFrameToEndpoint("0x01", 0x0bad, 1, frame, 1000, true, true)).rejects.toThrow("Delivery failed");
        ncp.busyOnce = 2;
        await adapter.sendZclFrameToEndpoint("0x01", 0x1234, 1, frame, 1000, true, true);
        ncp.overrides.set(M.Id.APS_DATA_REQUEST, () => Buffer.from([Status.TOO_LARGE]));
        await expect(adapter.sendZclFrameToEndpoint("0x01", 0x1234, 1, frame, 1000, true, true)).rejects.toThrow("TOO_LARGE");
    });

    it("sends ZDO to devices and resolves responses, NWK_addr by IEEE, and announces", async () => {
        make();
        await adapter.start();
        const zdoEvents: number[] = [];
        adapter.on("zdoResponse", (c) => zdoEvents.push(c));
        ncp.overrides.set(M.Id.APS_DATA_REQUEST, (req) => {
            const r = M.decodeMessage(req) as M.ApsDataRequestValue;
            setTimeout(() => {
                ncp.event(M.Id.EVT_APS_DATA_CONFIRM, M.EvtApsDataConfirm, {
                    reqTid: req.tid,
                    status: 0,
                    zbStatus: 0,
                    apsCounter: 1,
                    dstNwk: 0,
                    flags: 0,
                    elapsedMs: 1,
                });
                const tsn = r.asdu[0];

                if (r.cluster === Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST) {
                    ncp.indicate({profile: 0, srcEp: 0, dstEp: 0, srcNwk: 0x1234, cluster: 0x8005, asdu: Buffer.from([tsn, 0, 0x34, 0x12, 2, 1, 2])});
                } else if (r.cluster === Zdo.ClusterId.NETWORK_ADDRESS_REQUEST) {
                    ncp.indicate({
                        profile: 0,
                        srcEp: 0,
                        dstEp: 0,
                        srcNwk: 0x1234,
                        cluster: 0x8000,
                        asdu: Buffer.from([tsn, 0, ...DEV_ONAIR, 0x34, 0x12]),
                    });
                }
            }, 2);
            return Buffer.from([0]);
        });
        const ep = await adapter.sendZdo(
            DEV_IEEE,
            0x1234,
            Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, 0x1234),
            false,
        );
        expect(ep[1]?.endpointList).toStrictEqual([1, 2]);
        const req = M.decodeMessage(ncp.last(M.Id.APS_DATA_REQUEST) as M.Message) as M.ApsDataRequestValue;
        expect(req).toMatchObject({profile: 0, srcEp: 0, dstEp: 0, txOptions: 1});
        const nwk = await adapter.sendZdo(
            DEV_IEEE,
            ZSpec.BroadcastAddress.RX_ON_WHEN_IDLE,
            Zdo.ClusterId.NETWORK_ADDRESS_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, DEV_IEEE as Eui64, false, 0),
            false,
        );
        expect(nwk[1]?.nwkAddress).toStrictEqual(0x1234);
        expect((M.decodeMessage(ncp.last(M.Id.APS_DATA_REQUEST) as M.Message) as M.ApsDataRequestValue).dstMode).toStrictEqual(0x0f);
        // Device_annce, and a request the NCP already answered (ignored)
        ncp.indicate({profile: 0, srcNwk: 0x1234, cluster: 0x0013, asdu: Buffer.from([1, 0x34, 0x12, ...DEV_ONAIR, 0x80])});
        ncp.indicate({profile: 0, srcNwk: 0x1234, cluster: 0x0005, flags: 0x40, asdu: Buffer.from([1, 0, 0])});
        ncp.indicate({profile: 0, srcNwk: 0x1234, cluster: 0x8031, asdu: Buffer.from([1])}); // truncated: logged
        await until(() => zdoEvents.includes(0x0013));
        expect(zdoEvents).toContain(0x8005);
        // disableResponse ZDO
        await adapter.sendZdo(
            DEV_IEEE,
            0x1234,
            Zdo.ClusterId.LEAVE_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.LEAVE_REQUEST, DEV_IEEE as Eui64, Zdo.LeaveRequestFlags.WITHOUT_REJOIN),
            true,
        );
    });

    it("maps permit join and channel change, and answers coordinator ZDO locally", async () => {
        make();
        await adapter.start();
        await adapter.permitJoin(60);
        expect(M.NwkPermitJoinReq.decode(ncp.last(M.Id.NWK_PERMIT_JOIN)?.payload as Buffer)).toStrictEqual({durationS: 60, target: 0xfffc, flags: 1});
        await adapter.permitJoin(0, 0);
        expect(M.NwkPermitJoinReq.decode(ncp.last(M.Id.NWK_PERMIT_JOIN)?.payload as Buffer).target).toStrictEqual(0);
        const pj = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.PERMIT_JOINING_REQUEST, 30, 1, []);
        await adapter.sendZdo(ZSpec.BLANK_EUI64, 0xfffc, Zdo.ClusterId.PERMIT_JOINING_REQUEST, pj, true);
        expect(M.NwkPermitJoinReq.decode(ncp.last(M.Id.NWK_PERMIT_JOIN)?.payload as Buffer)).toStrictEqual({durationS: 30, target: 0xfffc, flags: 1});
        // a router: ZDO Mgmt_Permit_Joining_req to it, with response
        ncp.overrides.set(M.Id.APS_DATA_REQUEST, (req) => {
            const r = M.decodeMessage(req) as M.ApsDataRequestValue;
            setTimeout(() => {
                ncp.event(M.Id.EVT_APS_DATA_CONFIRM, M.EvtApsDataConfirm, {
                    reqTid: req.tid,
                    status: 0,
                    zbStatus: 0,
                    apsCounter: 1,
                    dstNwk: 0x1234,
                    flags: 0,
                    elapsedMs: 1,
                });
                ncp.indicate({profile: 0, srcEp: 0, dstEp: 0, srcNwk: 0x1234, cluster: 0x8036, asdu: Buffer.from([r.asdu[0], 0])});
            }, 2);
            return Buffer.from([0]);
        });
        await adapter.permitJoin(20, 0x1234);
        // channel change (Mgmt_NWK_Update_req, duration 0xFE) -> NWK_CHANGE_CHANNEL, unsupported by this NCP
        const upd = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NWK_UPDATE_REQUEST, [15], 0xfe, undefined, 1, undefined);
        await expect(adapter.sendZdo(ZSpec.BLANK_EUI64, 0xffff, Zdo.ClusterId.NWK_UPDATE_REQUEST, upd, true)).rejects.toThrow(
            "cannot change the channel",
        );
        // supported: answered at once, EVT_CHANNEL_CHANGED (matched by the request TID) after the broadcast delivery time
        let radio = 15;
        ncp.overrides.set(M.Id.NWK_CHANGE_CHANNEL, (req) => {
            const c = M.NwkChangeChannelReq.decode(req.payload);
            setTimeout(() => {
                ncp.event(M.Id.EVT_CHANNEL_CHANGED, M.EvtChannelChanged, {channel: 11, nwkUpdateId: 9, reqTid: (req.tid + 1) & 0xffff});
                if (ncp.network && radio === c.channel) {
                    ncp.network.channel = c.channel;
                    ncp.network.nwkUpdateId = c.nwkUpdateId;
                }
                ncp.event(M.Id.EVT_CHANNEL_CHANGED, M.EvtChannelChanged, {channel: radio, nwkUpdateId: c.nwkUpdateId, reqTid: req.tid});
            }, 30);
            return Buffer.from([0]);
        });
        ncp.busy.set(M.Id.NWK_CHANGE_CHANNEL, 1);
        await adapter.sendZdo(ZSpec.BLANK_EUI64, 0xffff, Zdo.ClusterId.NWK_UPDATE_REQUEST, upd, true);
        expect(M.NwkChangeChannelReq.decode(ncp.last(M.Id.NWK_CHANGE_CHANNEL)?.payload as Buffer)).toStrictEqual({channel: 15, nwkUpdateId: 1});
        expect((await adapter.getNetworkParameters()).channel).toStrictEqual(15);
        // a failed tune reports the old channel
        radio = 15;
        const upd2 = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NWK_UPDATE_REQUEST, [20], 0xfe, undefined, 2, undefined);
        await expect(adapter.sendZdo(ZSpec.BLANK_EUI64, 0xffff, Zdo.ClusterId.NWK_UPDATE_REQUEST, upd2, true)).rejects.toThrow(
            "stayed on channel 15",
        );
        // no event: fine if the NCP is on the channel, an error otherwise
        ncp.overrides.set(M.Id.NWK_CHANGE_CHANNEL, () => Buffer.from([0]));
        await adapter.sendZdo(ZSpec.BLANK_EUI64, 0xffff, Zdo.ClusterId.NWK_UPDATE_REQUEST, upd, true);
        await expect(adapter.sendZdo(ZSpec.BLANK_EUI64, 0xffff, Zdo.ClusterId.NWK_UPDATE_REQUEST, upd2, true)).rejects.toThrow(
            "did not report the move to channel 20",
        );
        // coordinator: power descriptor, IEEE_addr, unknown request, routes (DIAG unsupported -> empty)
        const coord = "0x8877665544332211";
        const pd = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.POWER_DESCRIPTOR_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.POWER_DESCRIPTOR_REQUEST, 0),
            false,
        );
        expect(pd[0]).toStrictEqual(Zdo.Status.SUCCESS);
        const ie = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.IEEE_ADDRESS_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.IEEE_ADDRESS_REQUEST, 0, false, 0),
            false,
        );
        expect(ie[1]?.eui64).toStrictEqual(coord);
        const rt = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.ROUTING_TABLE_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ROUTING_TABLE_REQUEST, 0),
            false,
        );
        expect(rt[1]?.routingTableEntries).toStrictEqual(0);
        const sd = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, 0, 9),
            false,
        );
        expect(sd[0]).toStrictEqual(Zdo.Status.NOT_ACTIVE);
        const bind = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.BIND_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.BIND_REQUEST, coord as Eui64, 1, 6, Zdo.UNICAST_BINDING, coord as Eui64, 0, 1),
            false,
        );
        expect(bind[0]).toStrictEqual(Zdo.Status.NOT_SUPPORTED);
        // neighbours served from DIAG_GET_NEIGHBORS when the NCP has it
        ncp.overrides.set(M.Id.DIAG_GET_NEIGHBORS, () =>
            M.encodeResponse(M.DiagGetNeighborsRsp, {
                total: 1,
                entries: [{ieee: DEV_ONAIR, nwk: 0x1234, deviceType: 1, rxOn: 1, relationship: 1, lqi: 200, outgoingCost: 1, age: 0}],
            }),
        );
        const lqi = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.LQI_TABLE_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.LQI_TABLE_REQUEST, 0),
            false,
        );
        expect(lqi[1]?.entryList[0]).toMatchObject({eui64: DEV_IEEE, nwkAddress: 0x1234, lqi: 200, deviceType: 1});
        await expect(adapter.setChannelInterPAN(11)).rejects.toThrow("Inter-PAN");
        await expect(adapter.sendZclFrameInterPANToIeeeAddr({} as Zcl.Frame, DEV_IEEE)).rejects.toThrow("Inter-PAN");
        await expect(adapter.sendZclFrameInterPANBroadcast({} as Zcl.Frame, 1, false)).rejects.toThrow("Inter-PAN");
        await expect(adapter.restoreChannelInterPAN()).rejects.toThrow("Inter-PAN");
    });

    it("pages DIAG tables into the coordinator's Mgmt_Lqi/Mgmt_Rtg, with children and route flags", async () => {
        make();
        await adapter.start();
        const coord = "0x8877665544332211";
        const neighbours = Array.from({length: 20}, (_, i) => ({
            ieee: Buffer.from([i + 1, 0, 0, 0, 0, 0, 0, 0x10]),
            nwk: 0x1000 + i,
            deviceType: i % 2 === 0 ? 1 : 2,
            rxOn: i % 2 === 0 ? 1 : 0,
            relationship: i % 2 === 0 ? 2 : 1,
            lqi: 100 + i,
            outgoingCost: 1,
            age: 0,
        }));
        ncp.overrides.set(M.Id.DIAG_GET_NEIGHBORS, (req) => {
            const start = M.DiagGetNeighborsReq.decode(req.payload).start;
            return M.encodeResponse(M.DiagGetNeighborsRsp, {total: 20, entries: neighbours.slice(start, start + 16)});
        });
        ncp.overrides.set(M.Id.DIAG_GET_CHILDREN, () =>
            M.encodeResponse(M.DiagGetChildrenRsp, {
                total: 2,
                entries: [
                    {ieee: neighbours[1].ieee, nwk: 0x1001, capability: 0x80, timeoutExp: 8, lastPollMs: 10},
                    {ieee: DEV_ONAIR, nwk: 0x2222, capability: 0x80, timeoutExp: 8, lastPollMs: 0xffffffff},
                ],
            }),
        );
        ncp.overrides.set(M.Id.DIAG_GET_ROUTES, () =>
            M.encodeResponse(M.DiagGetRoutesRsp, {
                total: 2,
                entries: [
                    {dst: 0x1000, nextHop: 0x1000, status: 0, flags: 0x02},
                    {dst: 0x1002, nextHop: 0x1000, status: 0, flags: 0x04},
                ],
            }),
        );
        const entries: ZdoTypes.LQITableEntry[] = [];
        let total = 0;

        do {
            const rsp = await adapter.sendZdo(
                coord,
                0,
                Zdo.ClusterId.LQI_TABLE_REQUEST,
                Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.LQI_TABLE_REQUEST, entries.length),
                false,
            );
            expect(rsp[0]).toStrictEqual(Zdo.Status.SUCCESS);
            total = rsp[1]?.neighborTableEntries ?? 0;
            expect(rsp[1]?.entryList.length).toBeLessThanOrEqual(3);
            entries.push(...(rsp[1]?.entryList ?? []));
        } while (entries.length < total);

        expect(total).toStrictEqual(21);
        expect(entries[0]).toMatchObject({nwkAddress: 0x1000, deviceType: 1, relationship: 2, lqi: 100});
        expect(entries[20]).toMatchObject({eui64: DEV_IEEE, nwkAddress: 0x2222, deviceType: 2, rxOnWhenIdle: 0, relationship: 1, lqi: 0});
        // the neighbour table is read page by page (16 entries)
        const starts = ncp.requests.filter((r) => r.msgId === M.Id.DIAG_GET_NEIGHBORS).map((r) => r.payload[0]);
        expect(starts.slice(0, 2)).toStrictEqual([0, 16]);
        const rt = await adapter.sendZdo(
            coord,
            0,
            Zdo.ClusterId.ROUTING_TABLE_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ROUTING_TABLE_REQUEST, 0),
            false,
        );
        expect(rt[1]?.entryList).toMatchObject([
            {destinationAddress: 0x1000, manyToOne: 1, routeRecordRequired: 0, nextHopAddress: 0x1000},
            {destinationAddress: 0x1002, manyToOne: 0, routeRecordRequired: 1},
        ]);
    });

    it("keeps the coordinator's group memberships on the NCP (genGroups to the coordinator, groupcasts)", async () => {
        ncp.groups = new Set();
        make();
        await adapter.start();
        // GP sink group on 242, ember's default groups on endpoint 1
        expect([...ncp.groups].sort()).toStrictEqual(["0:1", "2948:242", "901:1"]);
        const groups = (cmd: string, payload: object): Zcl.Frame =>
            Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, false, undefined, 9, cmd, "genGroups", payload, {});
        const parse = (p: ZclPayload | undefined): Record<string, unknown> =>
            Zcl.Frame.fromBuffer(p?.clusterID as number, p?.header, p?.data as Buffer, {}).payload;
        const add = await adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 1, groups("add", {groupid: 5, groupname: ""}), 1000, false, false);
        expect(add?.header?.commandIdentifier).toStrictEqual(0x00);
        expect(parse(add)).toStrictEqual({status: Zcl.Status.SUCCESS, groupid: 5});
        expect(ncp.groups.has("5:1")).toStrictEqual(true);
        const full = await adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 1, groups("add", {groupid: 6, groupname: ""}), 1000, false, false);
        expect(parse(full).status).toStrictEqual(Zcl.Status.INSUFFICIENT_SPACE);
        const removed = await adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 1, groups("remove", {groupid: 5}), 1000, false, false);
        expect(parse(removed)).toStrictEqual({status: Zcl.Status.SUCCESS, groupid: 5});
        await expect(
            adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 241, groups("addIfIdentifying", {groupid: 6, groupname: ""}), 1000, false, false),
        ).rejects.toThrow();
        // a groupcast makes the coordinator a member (ember's multicast passthrough), once
        const toggle = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 3, "toggle", "genOnOff", {}, {});
        await adapter.sendZclFrameToGroup(7, toggle);
        await adapter.sendZclFrameToGroup(7, toggle);
        expect(ncp.groups.has("7:1")).toStrictEqual(true);
        expect(ncp.requests.filter((r) => r.msgId === M.Id.NWK_GROUP_MEMBERSHIP && r.payload.readUInt16LE(1) === 7).length).toStrictEqual(1);
        // replayed after an NCP reboot
        ncp.groups.clear();
        ncp.reboot();
        await until(() => ncp.groups?.has("7:1") === true);
        expect(await adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 1, groups("removeAll", {}), 1000, false, false)).toBeUndefined();
        expect([...ncp.groups].filter((g) => g.endsWith(":1"))).toStrictEqual([]);
        // other commands to the coordinator are not sent
        expect(await adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 1, groups("view", {groupid: 5}), 1000, false, false)).toBeUndefined();
        // an NCP without NWK_GROUP_MEMBERSHIP: herdsman keeps the membership in its database only
        ncp.groups = undefined;
        expect(
            await adapter.sendZclFrameToEndpoint(ZSpec.BLANK_EUI64, 0, 1, groups("add", {groupid: 8, groupname: ""}), 1000, false, false),
        ).toBeUndefined();
    });

    it("uses the NCP's response budget (capacity 19) and retries BUSY on any request", async () => {
        ncp.capacities = [{id: 19, value: 384}];
        make();
        await adapter.start();
        expect(adapter.api.responseBudget).toStrictEqual(384);
        ncp.busy.set(M.Id.NWK_GET_INFO, 3);
        const before = adapter.api.counters.busyRetries;
        expect((await adapter.getNetworkParameters()).panID).toStrictEqual(0x2b2b);
        expect(adapter.api.counters.busyRetries - before).toStrictEqual(3);
        // concurrent echoes stay within the budget (64-byte echoes)
        const echoes = await Promise.all(
            Array.from({length: 4}, (_, i) => adapter.api.request(M.Id.SYS_ECHO, M.SysEchoReq, {data: Buffer.alloc(64, i)}, M.SysEchoRsp)),
        );
        expect(echoes.map(([, r]) => r?.data[0])).toStrictEqual([0, 1, 2, 3]);
        // without capacity 19: the host default
        await adapter.stop();
        ncp.capacities = [];
        ncp.reboot();
        make();
        await adapter.start();
        expect(adapter.api.responseBudget).toStrictEqual(1024);
    });

    it("compares the stored network before NWK_INIT (Z11) and restores over a running network (9.4 rule 1)", async () => {
        ncp.infoBeforeInit = true;
        ncp.network = {panId: 0x2b2b, extPanId: Buffer.from(EPID).reverse(), channel: 25, key: Buffer.from(KEY), keySeq: 0, nwkUpdateId: 0};
        make();
        expect(await adapter.start()).toStrictEqual("resumed");
        const ids = ncp.requests.map((r) => r.msgId);
        expect(ids.indexOf(M.Id.NWK_GET_INFO)).toBeLessThan(ids.indexOf(M.Id.NWK_INIT));
        expect(ncp.count(M.Id.NWK_INIT)).toStrictEqual(1);
        await adapter.stop();

        // another network runs; the backup matches the configuration: restored without a leave first
        ncp.network = {panId: 0x1111, extPanId: Buffer.alloc(8, 0x11), channel: 11, key: Buffer.alloc(16, 0x11), keySeq: 0, nwkUpdateId: 0};
        ncp.reboot();
        ncp.up = true;
        writeFileSync(
            join(dir, "coordinator_backup.json"),
            JSON.stringify({
                metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "x", internal: {}},
                coordinator_ieee: "8877665544332211",
                pan_id: "2b2b",
                extended_pan_id: Buffer.from(EPID).toString("hex"),
                nwk_update_id: 0,
                security_level: 5,
                channel: 25,
                channel_mask: [25],
                network_key: {key: Buffer.from(KEY).toString("hex"), sequence_number: 0, frame_counter: 0},
                devices: [],
            }),
        );
        let refuse = false;
        ncp.overrides.set(M.Id.BKP_RESTORE_BEGIN, () =>
            refuse && ncp.network ? Buffer.from([Status.INVALID_STATE]) : M.encodeResponse(M.BkpRestoreBeginRsp, {txn: 5, maxRecordsPerPut: 16}),
        );
        ncp.overrides.set(M.Id.BKP_RESTORE_PUT, () => M.encodeResponse(M.BkpRestorePutRsp, {accepted: 4, notes: []}));
        ncp.overrides.set(M.Id.BKP_RESTORE_COMMIT, () => {
            ncp.up = false;
            ncp.network = {panId: 0x2b2b, extPanId: Buffer.from(EPID).reverse(), channel: 25, key: Buffer.from(KEY), keySeq: 0, nwkUpdateId: 0};
            return M.encodeResponse(M.BkpRestoreCommitRsp, {
                nwkFcStart: 10000,
                apsFcStart: 1 << 20,
                linkKeysOnNcp: 0,
                linkKeysHostBacked: 0,
                children: 0,
            });
        });
        make();
        expect(await adapter.start()).toStrictEqual("restored");
        expect(ncp.count(M.Id.NWK_LEAVE_RESET)).toStrictEqual(0);
        await adapter.stop();

        // an NCP image that restores only with the stack stopped: wiped first
        ncp.network = {panId: 0x1111, extPanId: Buffer.alloc(8, 0x11), channel: 11, key: Buffer.alloc(16, 0x11), keySeq: 0, nwkUpdateId: 0};
        ncp.reboot();
        ncp.up = true;
        refuse = true;
        make();
        expect(await adapter.start()).toStrictEqual("restored");
        expect(ncp.count(M.Id.NWK_LEAVE_RESET)).toStrictEqual(1);
        expect(ncp.count(M.Id.BKP_RESTORE_BEGIN)).toStrictEqual(3);
    });

    it("adds install codes with the fallbacks SEC_ADD_INSTALL_CODE -> SEC_ADD_LINK_KEY -> TBL_PUSH", async () => {
        make();
        await adapter.start();
        const code = Buffer.from("88776655443322111122334455667788D490", "hex");
        await adapter.addInstallCode(DEV_IEEE, code, false);
        const push = M.TblPushReq.decode(ncp.last(M.Id.TBL_PUSH)?.payload as Buffer);
        const rec = push.records[0];
        expect(rec.type === RecordType.DEVICE && rec.value.link?.key.toString("hex")).toStrictEqual("fa8081caaa41d5ade9b5658799268b88");
        expect(ncp.count(M.Id.SEC_ADD_INSTALL_CODE)).toStrictEqual(1);
        ncp.overrides.set(M.Id.SEC_ADD_LINK_KEY, () => Buffer.from([0]));
        await adapter.addInstallCode(DEV_IEEE, Buffer.alloc(16, 1), true);
        expect(ncp.count(M.Id.TBL_PUSH)).toStrictEqual(1);
        ncp.overrides.set(M.Id.SEC_ADD_INSTALL_CODE, () => M.encodeResponse(M.SecAddInstallCodeRsp, {derivedKey: Buffer.alloc(16)}));
        await adapter.addInstallCode(DEV_IEEE, code, false);
        expect(ncp.count(M.Id.SEC_ADD_LINK_KEY)).toStrictEqual(2);
        ncp.overrides.delete(M.Id.SEC_ADD_LINK_KEY);
        ncp.overrides.set(M.Id.TBL_PUSH, () => M.encodeResponse(M.TblPushRsp, {results: [{status: Status.NO_SPACE, rev: 0}]}));
        await expect(adapter.addInstallCode(DEV_IEEE, Buffer.alloc(16, 1), true)).rejects.toThrow("NO_SPACE");
    });

    it("resumes seamlessly after an NCP reboot and replays the RAM configuration", async () => {
        make();
        await adapter.start();
        await adapter.permitJoin(200);
        const disconnected = vi.fn();
        adapter.on("disconnected", disconnected);
        const addEp = ncp.count(M.Id.NWK_ADD_ENDPOINT);
        const gpCfg = ncp.count(M.Id.GP_SINK_CONFIG);
        ncp.reboot();
        // a request issued during the outage waits for the resume instead of failing
        const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 3, "toggle", "genOnOff", {}, {});
        const pending = adapter.sendZclFrameToEndpoint(DEV_IEEE, 0x1234, 1, frame, 1000, true, true);
        await until(() => adapter.stats.ncpResumed === 1);
        await pending;
        expect(adapter.stats.ncpRestarts).toStrictEqual(1);
        expect(ncp.count(M.Id.NWK_ADD_ENDPOINT)).toStrictEqual(addEp + 1);
        expect(ncp.count(M.Id.GP_SINK_CONFIG)).toStrictEqual(gpCfg + 1);
        expect(ncp.count(M.Id.NWK_INIT)).toBeGreaterThanOrEqual(1);
        // the open permit-join window is replayed
        expect(M.NwkPermitJoinReq.decode(ncp.last(M.Id.NWK_PERMIT_JOIN)?.payload as Buffer).durationS).toBeGreaterThan(190);
        expect(disconnected).not.toHaveBeenCalled();
        // a soft reset through herdsman is just another reboot
        await adapter.reset("soft");
        await until(() => adapter.stats.ncpResumed === 2);
        expect(disconnected).not.toHaveBeenCalled();
    });

    it("resumes after the serial port vanishes (USB re-enumeration)", async () => {
        make({resumeBudgetMs: 8000});
        await adapter.start();
        port.openError = new Error("ENOENT");
        port.vanish();
        await new Promise((r) => setTimeout(r, 1200));
        port.openError = undefined;
        await until(() => adapter.stats.ncpResumed === 1, 5000);
        expect(adapter.api.counters.portReopened).toStrictEqual(1);
        await adapter.getNetworkParameters();
    }, 15_000);

    it("reports disconnected when the NCP comes back with another network or never comes back", async () => {
        make();
        await adapter.start();
        const disconnected = vi.fn();
        adapter.on("disconnected", disconnected);
        (ncp.network as {panId: number}).panId = 0x9999;
        ncp.reboot();
        await until(() => disconnected.mock.calls.length === 1);
        await adapter.stop();

        ncp = new MockNcp();
        make({hardResetOnFailure: true, resumeBudgetMs: 300});
        await adapter.start();
        const gone = vi.fn();
        adapter.on("disconnected", gone);
        ncp.powerOff();
        await until(() => gone.mock.calls.length === 1, 8000);
        // the hard reset sequence of spec 11.3: (0,0) -> (RTS 1, DTR 0) -> (0,0) -> (1,1)
        expect(port.lines).toStrictEqual([
            [false, false],
            [false, true],
            [false, false],
            [true, true],
        ]);
    }, 15_000);

    it("backs up through herdsman's format and keeps stack_specific.zigbee_rs; logs NCP events; persists checkpoints", async () => {
        make();
        await adapter.start();
        ncp.event(M.Id.EVT_FC_CHECKPOINT, M.EvtFcCheckpoint, {domain: 1, keySeq: 0, durableLimit: 6144, generation: 3});
        ncp.event(M.Id.EVT_TBL_EPOCH_CHANGED, M.EvtTblEpochChanged, {newEpoch: 7, reason: 2});
        ncp.event(M.Id.EVT_PERMIT_JOIN_STATE, M.EvtPermitJoinState, {remainingS: 10});
        ncp.event(M.Id.EVT_KEY_FAILURE, M.EvtKeyFailure, {ieee: DEV_ONAIR, nwk: 0x1234, reason: 1});
        ncp.event(M.Id.EVT_LOG_RECORD, M.EvtLogRecord, {timeMs: 1, level: 3, module: 1, seq: 1, text: Buffer.from("hello")});
        ncp.event(M.Id.EVT_FATAL, M.EvtFatal, {kind: 1, code: 2, text: Buffer.from("layout")});
        ncp.event(M.Id.EVT_INDICATIONS_DROPPED, M.EvtIndicationsDropped, {endpoint: 2, reason: 1, count: 3, firstMs: 0, lastMs: 1});
        ncp.event(M.Id.EVT_ROUTE_RECORD, M.EvtRouteRecord, {srcNwk: 1, srcIeee: DEV_ONAIR, relays: []});
        ncp.event(M.Id.EVT_NETWORK_STATE, M.EvtNetworkState, {state: 0, reason: 3, zbStatus: 0, reqTid: 0});
        await until(() => (adapter.store?.lastLimit(1) ?? 0) === 6144);
        expect(adapter.store?.floors(1024)).toStrictEqual([6144 + 9 * 1024, 0]);
        const backup = await adapter.backup([DEV_IEEE]);
        expect(backup.stackSpecific?.zigbee_rs).toMatchObject({version: 1, nwk_frame_counter_limit: 5120, aps_frame_counter_limit: 3072});
        expect(backup.devices).toHaveLength(1);
        expect(backup.devices[0].linkKey?.txCounter).toStrictEqual(3072);
        expect(backup.coordinatorIeeeAddress.toString("hex")).toStrictEqual("8877665544332211");
        const unified = BackupUtils.toUnifiedBackup(backup);
        expect((unified.stack_specific as Record<string, unknown>).zigbee_rs).toBeDefined();
        expect((unified.metadata.internal.network as {tc_link_key: {frame_counter: number}}).tc_link_key.frame_counter).toStrictEqual(3072);
        const back = BackupUtils.fromUnifiedBackup(JSON.parse(JSON.stringify(unified)));
        expect(back.stackSpecific?.zigbee_rs).toStrictEqual(backup.stackSpecific?.zigbee_rs);
        expect(await adapter.backup([])).toMatchObject({devices: []});
        expect(await adapter.supportsBackup()).toStrictEqual(true);
        const version = await adapter.getCoordinatorVersion();
        expect(version.meta).toMatchObject({revision: "mock/1.0", transport: "usb-serial-jtag", product: "mock NCP"});
        // the next start passes the checkpoint floors in NWK_INIT
        await adapter.stop();
        ncp.reboot();
        make();
        expect(await adapter.start()).toStrictEqual("resumed");
        const init = M.NwkInitReq.decode(ncp.last(M.Id.NWK_INIT)?.payload as Buffer);
        expect(init.nwkFcFloor).toStrictEqual(6144 + 9 * 1024);
    });

    it("herdsman's backup conversion passes unknown sections through and tolerates their absence", () => {
        const base = {
            metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "x"},
            coordinator_ieee: "0102030405060708",
            pan_id: "1a2b",
            extended_pan_id: "dddddddddddddd02",
            nwk_update_id: 0,
            security_level: 5,
            channel: 11,
            channel_mask: [11],
            network_key: {key: "00".repeat(16), sequence_number: 0, frame_counter: 0},
            devices: [],
        };
        const bare = BackupUtils.fromUnifiedBackup(base as unknown as Parameters<typeof BackupUtils.fromUnifiedBackup>[0]);
        expect(bare.stackSpecific).toBeUndefined();
        expect(bare.internal).toBeUndefined();
        const full = BackupUtils.fromUnifiedBackup({
            ...base,
            metadata: {...base.metadata, internal: {date: "d", ezspVersion: 13, network: {tc_link_key: {frame_counter: 7}}}},
            stack_specific: {ezsp: {hashed_tclk: "00"}, zigbee_rs: {version: 1}},
        } as unknown as Parameters<typeof BackupUtils.fromUnifiedBackup>[0]);
        expect(full.stackSpecific).toStrictEqual({zigbee_rs: {version: 1}});
        expect(full.internal).toStrictEqual({network: {tc_link_key: {frame_counter: 7}}});
        const out = BackupUtils.toUnifiedBackup(full);
        expect(out.stack_specific?.zigbee_rs).toStrictEqual({version: 1});
        expect(out.metadata.internal.network).toStrictEqual({tc_link_key: {frame_counter: 7}});
        expect(out.metadata.internal.ezspVersion).toStrictEqual(13);
    });

    it("locks key export after a backup when configured", async () => {
        make({lockKeyExport: true});
        await adapter.start();
        await adapter.backup([]);
        expect(ncp.count(M.Id.SEC_LOCK_KEY_EXPORT)).toStrictEqual(1);
        expect(await adapter.supportsBackup()).toStrictEqual(false);
    });

    it("serves TBL_WRITEBACK and TBL_LOOKUP from the sidecar store", async () => {
        make();
        await adapter.start();
        const rec = {
            type: RecordType.DEVICE as const,
            value: {
                ieee: DEV_ONAIR,
                nwk: 0x1234,
                flags: 0x08,
                link: {key: Buffer.alloc(16, 0xcd), keySeq: 0, attrs: 2, origin: 2, txCounter: 0, rxFloor: 4},
            },
        };
        const ask = (msgId: M.Id, payload: Buffer): void => {
            ncp.queues.push(2, M.encodeMessage({kind: 0, msgId, tid: 77, payload}));
            ncp.schedule();
        };
        ask(M.Id.TBL_WRITEBACK, M.TblWritebackReq.encode({table: 5, reason: 1, rev: 9, record: rec}));
        await until(() => adapter.store?.keys.size === 1);
        ask(M.Id.TBL_LOOKUP, M.TblLookupReq.encode({table: 5, key: {keyType: 2, key: 0x1234}}));
        ask(M.Id.TBL_LOOKUP, M.TblLookupReq.encode({table: 5, key: {keyType: 1, key: Buffer.alloc(8)}}));
        ask(M.Id.TBL_WRITEBACK, M.TblWritebackReq.encode({table: 5, reason: 4, rev: 10, record: rec}));
        await until(() => adapter.store?.keys.size === 0);
        // the store survives a reopen (compaction)
        const s = new SidecarStore(join(dir, "zrhp_store.jsonl"));
        s.open();
        expect(s.meta.hostMaxRev).toStrictEqual(9);
        s.close();
    });

    it("restores a matching backup onto an unformed NCP with margins and the IEEE rule", async () => {
        const ocb = {
            metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "zigbee-herdsman@11", internal: {date: "x", custom: {a: 1}}},
            stack_specific: {zstack: {tclk_seed: "00"}},
            coordinator_ieee: "0102030405060708",
            pan_id: "2b2b",
            extended_pan_id: Buffer.from(EPID).toString("hex"),
            nwk_update_id: 0,
            security_level: 5,
            channel: 25,
            channel_mask: [25],
            network_key: {key: Buffer.from(KEY).toString("hex"), sequence_number: 0, frame_counter: 1000},
            devices: [
                {
                    nwk_address: "1234",
                    ieee_address: "0807060504030201",
                    is_child: false,
                    link_key: {key: "ab".repeat(16), rx_counter: 1, tx_counter: 2},
                },
            ],
        };
        writeFileSync(join(dir, "coordinator_backup.json"), JSON.stringify(ocb));
        const puts: Buffer[] = [];
        ncp.overrides.set(M.Id.BKP_RESTORE_BEGIN, () => M.encodeResponse(M.BkpRestoreBeginRsp, {txn: 5, maxRecordsPerPut: 3}));
        ncp.overrides.set(M.Id.BKP_RESTORE_PUT, (req) => {
            puts.push(M.BkpRestorePutReq.decode(req.payload).records);
            return M.encodeResponse(M.BkpRestorePutRsp, {accepted: 3, notes: [{index: 0, note: 3}]});
        });
        ncp.overrides.set(M.Id.BKP_RESTORE_COMMIT, () => {
            ncp.network = {panId: 0x2b2b, extPanId: Buffer.from(EPID).reverse(), channel: 25, key: Buffer.from(KEY), keySeq: 0, nwkUpdateId: 0};
            return M.encodeResponse(M.BkpRestoreCommitRsp, {
                nwkFcStart: 11000,
                apsFcStart: 1048578,
                linkKeysOnNcp: 1,
                linkKeysHostBacked: 0,
                children: 0,
            });
        });
        make();
        expect(await adapter.start()).toStrictEqual("restored");
        const begin = M.BkpRestoreBeginReq.decode(ncp.last(M.Id.BKP_RESTORE_BEGIN)?.payload as Buffer);
        // no IEEE_REWRITABLE: restored under the NCP's own IEEE; Z2M backup without TCLK counter: 2^20
        expect(begin).toStrictEqual({flags: 0, nwkMargin: 10000, apsMargin: 1 << 20, expectedRecords: 6});
        expect(puts.length).toStrictEqual(2);
        expect(adapter.store?.lastLimit(2)).toStrictEqual(1048578);
        // unknown sections and internal keys are passed through to the next backup
        const b = await adapter.backup(["0x0102030405060708"]);
        expect(b.znp?.trustCenterLinkKeySeed?.toString("hex")).toStrictEqual("00");
        expect(b.internal).toMatchObject({custom: {a: 1}});
        const unified = BackupUtils.toUnifiedBackup(b);
        expect(unified.stack_specific?.zstack).toStrictEqual({tclk_seed: "00"});
        expect(ocbToHerdsmanBackup(JSON.parse(JSON.stringify(unified))).znp?.trustCenterLinkKeySeed?.toString("hex")).toStrictEqual("00");
    });

    it("aborts a failed restore and does not accept network transports", async () => {
        writeFileSync(
            join(dir, "coordinator_backup.json"),
            JSON.stringify({
                metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "x", internal: {}},
                coordinator_ieee: "1122334455667788",
                pan_id: "2b2b",
                extended_pan_id: Buffer.from(EPID).toString("hex"),
                nwk_update_id: 0,
                security_level: 5,
                channel: 25,
                channel_mask: [25],
                network_key: {key: Buffer.from(KEY).toString("hex"), sequence_number: 0, frame_counter: 0},
                devices: [],
            }),
        );
        ncp.overrides.set(M.Id.BKP_RESTORE_BEGIN, () => M.encodeResponse(M.BkpRestoreBeginRsp, {txn: 5, maxRecordsPerPut: 16}));
        ncp.overrides.set(M.Id.BKP_RESTORE_PUT, () => Buffer.from([Status.INVALID_PARAMETER]));
        make();
        await expect(adapter.start()).rejects.toThrow("BKP_RESTORE_PUT failed: INVALID_PARAMETER");
        expect(ncp.count(M.Id.BKP_RESTORE_ABORT)).toStrictEqual(1);
        await adapter.stop();
        const tcp = new ZrhpAdapter({panID: 1, extendedPanID: EPID, channelList: [11]}, {path: "tcp://1.2.3.4:6638"}, join(dir, "b.json"), {
            disableLED: false,
        });
        await expect(tcp.start()).rejects.toThrow("no network transport");
    });

    it("fails cleanly when the NCP never answers", async () => {
        ncp.powerOff();
        make({connectTimeoutMs: 300});
        await expect(adapter.start()).rejects.toThrow("No ZRHP session");
    });

    it("is created by Adapter.create for adapter: zrhp", async () => {
        const a = await Adapter.create(
            {panID: 1, extendedPanID: EPID, channelList: [11], networkKey: KEY},
            {path: "/dev/ttyACM-zrhp", adapter: "zrhp"},
            join(dir, "x.json"),
            {disableLED: false},
        );
        expect(a).toBeInstanceOf(ZrhpAdapter);
        expect(readFileSync).toBeDefined();
    });
});

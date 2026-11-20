/**
 * ZDO requests to the coordinator itself, answered on the host (ZRHP spec 7.4).
 *
 * ZRHP has no ZDO loopback: the NCP refuses profile-0 frames to its own address. herdsman still sends them (interview of the
 * coordinator, network map), so the adapter synthesizes the responses from `NWK_GET_INFO` / `DIAG_*` and the registered
 * endpoints. Responses are raw ZDO payloads (TSN first), parsed by herdsman's `Zdo.Buffalo` like any other response.
 */

import * as Zdo from "../../zspec/zdo";

export interface LocalEndpoint {
    endpoint: number;
    profileId: number;
    deviceId: number;
    deviceVersion: number;
    inClusters: number[];
    outClusters: number[];
}

export interface Neighbor {
    /** on-air order */
    ieee: Buffer;
    nwk: number;
    deviceType: number;
    rxOn: number;
    relationship: number;
    lqi: number;
}

export interface Route {
    dst: number;
    nextHop: number;
    status: number;
}

export interface LocalZdoContext {
    /** on-air order */
    ieee: Buffer;
    /** on-air order */
    extPanId: Buffer;
    manufacturerCode: number;
    endpoints: LocalEndpoint[];
    neighbors(): Promise<Neighbor[] | undefined>;
    routes(): Promise<Route[] | undefined>;
}

/** `server_mask`: stack compliance revision 22, primary TC, network manager. */
const SERVER_MASK = 0x2c41;
/** Alternate PAN coordinator, FFD, mains, receiver on when idle, allocate address. */
const MAC_CAPABILITY = 0x8f;

function u16(v: number): number[] {
    return [v & 0xff, (v >> 8) & 0xff];
}

/** Whether a ZDO request is addressed to the coordinator. */
export function isLocalZdo(networkAddress: number, ieeeAddress: string | undefined, coordinatorIeee: string): boolean {
    return networkAddress === 0x0000 || (ieeeAddress !== undefined && ieeeAddress.toLowerCase() === coordinatorIeee.toLowerCase());
}

/** The response payload (TSN first) of a ZDO request to the coordinator, or `undefined` for requests that get none. */
export async function localZdoResponse(ctx: LocalZdoContext, clusterId: number, request: Buffer): Promise<Buffer | undefined> {
    const tsn = request[0] ?? 0;
    const status = Zdo.Status.SUCCESS;

    switch (clusterId) {
        case Zdo.ClusterId.NETWORK_ADDRESS_REQUEST:
        case Zdo.ClusterId.IEEE_ADDRESS_REQUEST: {
            return Buffer.from([tsn, status, ...ctx.ieee, ...u16(0x0000)]);
        }
        case Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST: {
            return Buffer.from([
                tsn,
                status,
                ...u16(0x0000),
                0x00, // coordinator, no complex/user descriptor
                0x40, // 2.4 GHz
                MAC_CAPABILITY,
                ...u16(ctx.manufacturerCode),
                82, // max buffer size
                ...u16(128), // max incoming transfer
                ...u16(SERVER_MASK),
                ...u16(128), // max outgoing transfer
                0x00,
            ]);
        }
        case Zdo.ClusterId.POWER_DESCRIPTOR_REQUEST: {
            return Buffer.from([tsn, status, ...u16(0x0000), 0x10, 0xc1]);
        }
        case Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST: {
            const eps = ctx.endpoints.map((e) => e.endpoint).sort((a, b) => a - b);

            return Buffer.from([tsn, status, ...u16(0x0000), eps.length, ...eps]);
        }
        case Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST: {
            const ep = request[3];
            const desc = ctx.endpoints.find((e) => e.endpoint === ep);

            if (!desc) {
                return Buffer.from([tsn, Zdo.Status.NOT_ACTIVE, ...u16(0x0000), 0]);
            }

            const body = [
                desc.endpoint,
                ...u16(desc.profileId),
                ...u16(desc.deviceId),
                desc.deviceVersion,
                desc.inClusters.length,
                ...desc.inClusters.flatMap(u16),
                desc.outClusters.length,
                ...desc.outClusters.flatMap(u16),
            ];

            return Buffer.from([tsn, status, ...u16(0x0000), body.length, ...body]);
        }
        case Zdo.ClusterId.LQI_TABLE_REQUEST: {
            const start = request[1] ?? 0;
            const all = (await ctx.neighbors()) ?? [];
            const page = all.slice(start, start + 2);
            const entries = page.flatMap((n) => [
                ...ctx.extPanId,
                ...n.ieee,
                ...u16(n.nwk),
                (n.deviceType & 0x03) | ((n.rxOn & 0x03) << 2) | ((n.relationship & 0x07) << 4),
                0x02, // permit joining unknown
                n.deviceType === 0 ? 0 : 1, // depth
                n.lqi,
            ]);

            return Buffer.from([tsn, status, all.length, start, page.length, ...entries]);
        }
        case Zdo.ClusterId.ROUTING_TABLE_REQUEST: {
            const start = request[1] ?? 0;
            const all = (await ctx.routes()) ?? [];
            const page = all.slice(start, start + 10);
            const entries = page.flatMap((r) => [...u16(r.dst), r.status & 0x07, ...u16(r.nextHop)]);

            return Buffer.from([tsn, status, all.length, start, page.length, ...entries]);
        }
        default: {
            // Bind/Unbind/Leave of the coordinator itself have no ZRHP equivalent in v1 (permit join and channel change are
            // mapped to NWK_* commands before they get here).
            return (clusterId & 0x8000) !== 0 ? undefined : Buffer.from([tsn, Zdo.Status.NOT_SUPPORTED]);
        }
    }
}

/** Shared ZRHP protocol enums: link endpoints, message kinds, status codes, capabilities (spec 5.10, 6). */

/** Link endpoints (spec 5.10). Not Zigbee endpoints. */
export enum LinkEndpoint {
    LINK = 0,
    SYSTEM = 1,
    ZIGBEE = 2,
    TABLES = 3,
    BULK = 4,
    LOG = 5,
}

/** Number of link endpoint slots (0..5). */
export const NEP = 6;

export const DATA_ENDPOINTS: readonly LinkEndpoint[] = [
    LinkEndpoint.SYSTEM,
    LinkEndpoint.ZIGBEE,
    LinkEndpoint.TABLES,
    LinkEndpoint.BULK,
    LinkEndpoint.LOG,
];

/** Endpoints in scheduler priority order (spec 5.10: SYSTEM 1, TABLES 2, ZIGBEE 3, BULK 4, LOG 5). */
export const BY_PRIORITY: readonly LinkEndpoint[] = [
    LinkEndpoint.SYSTEM,
    LinkEndpoint.TABLES,
    LinkEndpoint.ZIGBEE,
    LinkEndpoint.BULK,
    LinkEndpoint.LOG,
];

/** BULK and LOG share at most half of the window (rule S0). */
export function isBulkClass(ep: LinkEndpoint): boolean {
    return ep === LinkEndpoint.BULK || ep === LinkEndpoint.LOG;
}

export enum Kind {
    REQUEST = 0,
    RESPONSE = 1,
    EVENT = 2,
}

/** Message-level status codes (spec 6.4). */
export enum Status {
    SUCCESS = 0x00,
    FAILURE = 0x01,
    BUSY = 0x02,
    INVALID_PARAMETER = 0x03,
    UNSUPPORTED_COMMAND = 0x04,
    INVALID_STATE = 0x05,
    NOT_FOUND = 0x06,
    NO_SPACE = 0x07,
    TIMEOUT = 0x08,
    LINK_RESET = 0x09,
    ACCESS_DENIED = 0x0a,
    NOT_FORMED = 0x0b,
    ALREADY_EXISTS = 0x0c,
    STORAGE_ERROR = 0x0d,
    SECURITY_ERROR = 0x0e,
    VERSION_MISMATCH = 0x0f,
    IN_PROGRESS = 0x10,
    TOO_LARGE = 0x11,
    WRONG_ENDPOINT = 0x12,
    CONFLICT = 0x13,
    ABORTED = 0x14,
    LINK_REJECTED = 0x15,
}

export function statusName(status: number): string {
    return Status[status] ?? `0x${status.toString(16).padStart(2, "0")}`;
}

/** NCP capability bits (spec 6.6). */
export const NcpCaps = {
    HOST_SOURCE_ROUTES: 1n << 0n,
    CONCENTRATOR: 1n << 1n,
    APS_FRAGMENTATION: 1n << 2n,
    INSTALL_CODES: 1n << 3n,
    KEY_EXPORT: 1n << 4n,
    IEEE_REWRITABLE: 1n << 5n,
    HOST_BACKED_TABLES: 1n << 6n,
    NCP_FW_UPDATE: 1n << 7n,
    GREEN_POWER_PROXY: 1n << 8n,
    ENERGY_SCAN: 1n << 9n,
    NETWORK_KEY_ROTATION: 1n << 10n,
    PACKET_CAPTURE: 1n << 12n,
    LINK_AUTH: 1n << 13n,
    EZSP_HASHED_TCLK: 1n << 14n,
    BACKUP_RESTORE: 1n << 15n,
    MANUFACTURER_CODE: 1n << 16n,
    GROUP_MEMBERSHIP: 1n << 17n,
    TX_POWER: 1n << 18n,
    INTERPAN: 1n << 19n,
    GREEN_POWER_SINK: 1n << 20n,
    PTA_COEX: 1n << 21n,
    UART_FLOW_CONTROL: 1n << 22n,
} as const;

/** Host capability bits (spec 8.8). */
export const HostCaps = {
    HOST_TABLES: 1n << 0n,
    FC_CHECKPOINTS: 1n << 1n,
    RETRY_CACHE: 1n << 2n,
    GP_SHADOW: 1n << 3n,
} as const;

/** Capacity IDs of `SYS_NEGOTIATE` (spec 6.6). */
export enum Capacity {
    MAX_APS_INFLIGHT = 1,
    MAX_CHILDREN = 2,
    LINK_KEY_CACHE = 3,
    ADDRESS_MAP_CACHE = 4,
    SOURCE_ROUTE_CACHE = 5,
    MAX_ASDU = 6,
    FC_STRIDE = 7,
    MAX_HOST_ENDPOINTS = 8,
    GROUP_TABLE = 9,
    BINDING_TABLE = 10,
    NEIGHBOR_TABLE = 11,
    ROUTE_TABLE = 12,
    MAX_RESTORE_RECORDS_PER_PUT = 13,
    MAX_SOURCE_ROUTE_RELAYS = 14,
    GP_SINK_TABLE = 15,
    GP_PROXY_TABLE = 16,
    MAX_NCP_REQUESTS = 17,
    MAX_TC_DEVICES = 18,
    /** response bytes a host may keep outstanding per endpoint (5.10) */
    HOST_RESPONSE_BYTES = 19,
}

/** `EVT_NCP_READY.network_state` / `NWK_GET_INFO.state`. */
export enum NetworkState {
    NONE = 0,
    FORMED_DOWN = 1,
    UP = 2,
}

/** `APS_DATA_REQUEST.tx_options` (spec 7.3). */
export const TxOptions = {
    APS_ACK: 0x01,
    APS_SECURITY: 0x02,
    FORCE_ROUTE_DISCOVERY: 0x04,
    FRAGMENTATION: 0x08,
    USE_ALIAS: 0x10,
    EXTENDED_TIMEOUT: 0x20,
    SOURCE_ROUTE: 0x40,
} as const;

/** `EVT_APS_DATA_INDICATION.flags` (spec 7.3). */
export const IndicationFlags = {
    APS_SECURED: 0x01,
    NWK_SECURED: 0x02,
    SRC_IEEE_VALID: 0x04,
    BROADCAST: 0x08,
    GROUPCAST: 0x10,
    REASSEMBLED: 0x20,
    HANDLED_BY_NCP: 0x40,
    LOCAL_LOOPBACK: 0x80,
} as const;

/** APS address modes of `APS_DATA_REQUEST` / indications (zigpy `AddrMode` values). */
export enum AddrMode {
    GROUP = 0x01,
    NWK = 0x02,
    IEEE = 0x03,
    BROADCAST = 0x0f,
}

/** Confirm word of `SYS_RESET` mode 2 ("FRES"). */
export const FACTORY_RESET_CONFIRM = 0x46524553;
/** Confirm word of `SEC_LOCK_KEY_EXPORT` ("LOCK"). */
export const LOCK_CONFIRM = 0x4b434f4c;
/** `FRAME_COUNTER_RESERVATION_SIZE`. */
export const FC_STRIDE = 0x400;
/** Zigbee APS NO_ACK (`zb_status`). */
export const ZB_APS_NO_ACK = 0xa7;

/**
 * RPC Semantic Convention attributes for OpenTelemetry
 *
 * Based on:
 * - https://opentelemetry.io/docs/specs/semconv/rpc/connect-rpc/
 * - https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/
 * - https://opentelemetry.io/docs/specs/semconv/attributes-registry/rpc/
 *
 * @module attributes
 */

// RPC system identifier
export const RPC_SYSTEM_CONNECT_RPC = "connect_rpc";

// Attribute keys (per OTel semantic conventions)
export const ATTR_RPC_SYSTEM = "rpc.system";
export const ATTR_RPC_SERVICE = "rpc.service";
export const ATTR_RPC_METHOD = "rpc.method";
export const ATTR_RPC_CONNECT_RPC_STATUS_CODE = "rpc.connect_rpc.status_code";
export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_SERVER_ADDRESS = "server.address";
export const ATTR_SERVER_PORT = "server.port";
export const ATTR_NETWORK_PROTOCOL_NAME = "network.protocol.name";
export const ATTR_NETWORK_TRANSPORT = "network.transport";
export const ATTR_NETWORK_PEER_ADDRESS = "network.peer.address";
export const ATTR_NETWORK_PEER_PORT = "network.peer.port";

/**
 * Connectum-specific span attribute that distinguishes RPC observations
 * carried by the in-process router transport from those carried by HTTP/2.
 *
 * Values:
 *   - `"in-process"` — the call traversed `createLocalTransport`
 *   - `"http"`       — the call traversed `createGrpcTransport` /
 *                      `createConnectTransport` (the network path)
 *
 * Parity tests strip this attribute before structural diffing so that the
 * remaining shape (spans, events, metric instruments) is invariant across
 * transports.
 *
 * @see ATTR_CONNECTUM_TRANSPORT_METRIC for the metric-label counterpart
 */
export const ATTR_CONNECTUM_TRANSPORT = "connectum.transport";
/**
 * Metric-label counterpart of {@link ATTR_CONNECTUM_TRANSPORT}.
 *
 * Uses the short, lowercase form to align with OpenTelemetry metric
 * label conventions and existing `network.*` keys.
 */
export const ATTR_CONNECTUM_TRANSPORT_METRIC = "transport";
/** Marker request header set by `createLocalTransport` from `@connectum/core`. */
export const CONNECTUM_INTERNAL_TRANSPORT_HEADER = "connectum-internal-transport";
/** Header value indicating an in-process call (the only one currently defined). */
export const CONNECTUM_INTERNAL_TRANSPORT_IN_PROCESS = "in-process";

// RPC message event constants (per OTel semconv)
export const RPC_MESSAGE_EVENT = "rpc.message";
export const ATTR_RPC_MESSAGE_TYPE = "rpc.message.type";
export const ATTR_RPC_MESSAGE_ID = "rpc.message.id";
export const ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE = "rpc.message.uncompressed_size";

/**
 * ConnectRPC error code map (numeric code -> string name)
 * Based on Connect protocol error codes
 */
export const ConnectErrorCode = {
    CANCELED: 1,
    UNKNOWN: 2,
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    NOT_FOUND: 5,
    ALREADY_EXISTS: 6,
    PERMISSION_DENIED: 7,
    RESOURCE_EXHAUSTED: 8,
    FAILED_PRECONDITION: 9,
    ABORTED: 10,
    OUT_OF_RANGE: 11,
    UNIMPLEMENTED: 12,
    INTERNAL: 13,
    UNAVAILABLE: 14,
    DATA_LOSS: 15,
    UNAUTHENTICATED: 16,
} as const;

export type ConnectErrorCode = (typeof ConnectErrorCode)[keyof typeof ConnectErrorCode];

/**
 * Reverse map: numeric code -> string name for span attributes
 */
export const ConnectErrorCodeName: Record<number, string> = {
    1: "CANCELED",
    2: "UNKNOWN",
    3: "INVALID_ARGUMENT",
    4: "DEADLINE_EXCEEDED",
    5: "NOT_FOUND",
    6: "ALREADY_EXISTS",
    7: "PERMISSION_DENIED",
    8: "RESOURCE_EXHAUSTED",
    9: "FAILED_PRECONDITION",
    10: "ABORTED",
    11: "OUT_OF_RANGE",
    12: "UNIMPLEMENTED",
    13: "INTERNAL",
    14: "UNAVAILABLE",
    15: "DATA_LOSS",
    16: "UNAUTHENTICATED",
};

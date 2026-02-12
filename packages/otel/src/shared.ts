/**
 * Shared utilities for server and client OTel interceptors
 *
 * Contains common helper functions used by both createOtelInterceptor()
 * and createOtelClientInterceptor().
 *
 * @module shared
 */

import { ConnectError } from "@connectrpc/connect";
import type { Attributes } from "@opentelemetry/api";

import {
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_PROTOCOL_NAME,
    ATTR_RPC_CONNECT_RPC_STATUS_CODE,
    ATTR_RPC_METHOD,
    ATTR_RPC_SERVICE,
    ATTR_RPC_SYSTEM,
    ATTR_SERVER_ADDRESS,
    ATTR_SERVER_PORT,
    ConnectErrorCodeName,
    RPC_SYSTEM_CONNECT_RPC,
} from "./attributes.ts";
import type { OtelAttributeFilter } from "./types.ts";

/**
 * Estimates the serialized size of a protobuf message in bytes.
 *
 * If the message exposes a `toBinary()` method (standard for protobuf-es messages),
 * returns the byte length of the serialized form. Otherwise returns 0.
 *
 * @param message - The message to estimate size for
 * @returns Size in bytes, or 0 if size cannot be determined
 */
export function estimateMessageSize(message: unknown): number {
    if (message == null) return 0;
    if (typeof message === "object" && "toBinary" in message && typeof (message as { toBinary: unknown }).toBinary === "function") {
        return (message as { toBinary(): Uint8Array }).toBinary().byteLength;
    }
    return 0;
}

/**
 * Builds error-specific attributes for spans and metrics.
 *
 * For ConnectError instances, records the Connect error code name and numeric code.
 * For generic Error instances, records the error constructor name.
 * For unknown error types, records "UNKNOWN".
 *
 * @param error - The caught error
 * @returns Record of error attributes to attach to spans/metrics
 */
export function buildErrorAttributes(error: unknown): Record<string, string | number> {
    const attrs: Record<string, string | number> = {};
    if (error instanceof ConnectError) {
        attrs[ATTR_ERROR_TYPE] = ConnectErrorCodeName[error.code] ?? "UNKNOWN";
        attrs[ATTR_RPC_CONNECT_RPC_STATUS_CODE] = error.code;
    } else if (error instanceof Error) {
        attrs[ATTR_ERROR_TYPE] = error.constructor.name;
    } else {
        attrs[ATTR_ERROR_TYPE] = "UNKNOWN";
    }
    return attrs;
}

/**
 * Parameters for building base RPC attributes.
 */
export interface BaseAttributeParams {
    service: string;
    method: string;
    serverAddress: string;
    serverPort?: number | undefined;
}

/**
 * Builds standard RPC base attributes per OTel semantic conventions.
 *
 * @param params - Service, method, server address/port info
 * @returns Record of base attributes
 */
export function buildBaseAttributes(params: BaseAttributeParams): Record<string, string | number> {
    const attrs: Record<string, string | number> = {
        [ATTR_RPC_SYSTEM]: RPC_SYSTEM_CONNECT_RPC,
        [ATTR_RPC_SERVICE]: params.service,
        [ATTR_RPC_METHOD]: params.method,
        [ATTR_SERVER_ADDRESS]: params.serverAddress,
        [ATTR_NETWORK_PROTOCOL_NAME]: "connect_rpc",
    };
    if (params.serverPort !== undefined) {
        attrs[ATTR_SERVER_PORT] = params.serverPort;
    }
    return attrs;
}

/**
 * Applies an attribute filter to the given attributes.
 *
 * @param attrs - Base attributes to filter
 * @param filter - Optional filter function
 * @returns Filtered attributes
 */
export function applyAttributeFilter(attrs: Record<string, string | number>, filter?: OtelAttributeFilter): Attributes {
    if (!filter) return attrs;
    return Object.fromEntries(Object.entries(attrs).filter(([key, value]) => filter(key, value)));
}

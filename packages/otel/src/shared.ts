/**
 * Shared utilities for server and client OTel interceptors
 *
 * Contains common helper functions used by both createOtelInterceptor()
 * and createOtelClientInterceptor().
 *
 * @module shared
 */

import { ConnectError } from "@connectrpc/connect";
import type { Attributes, Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";

import {
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_PROTOCOL_NAME,
    ATTR_NETWORK_TRANSPORT,
    ATTR_RPC_CONNECT_RPC_STATUS_CODE,
    ATTR_RPC_MESSAGE_ID,
    ATTR_RPC_MESSAGE_TYPE,
    ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE,
    ATTR_RPC_METHOD,
    ATTR_RPC_SERVICE,
    ATTR_RPC_SYSTEM,
    ATTR_SERVER_ADDRESS,
    ATTR_SERVER_PORT,
    ConnectErrorCodeName,
    RPC_MESSAGE_EVENT,
    RPC_SYSTEM_CONNECT_RPC,
} from "./attributes.ts";
import type { OtelAttributeFilter } from "./types.ts";

/**
 * WeakMap cache for message size estimation.
 * Avoids redundant toBinary() calls for the same message object.
 */
const sizeCache = new WeakMap<object, number>();

/**
 * Estimates the serialized size of a protobuf message in bytes.
 *
 * If the message exposes a `toBinary()` method (standard for protobuf-es messages),
 * returns the byte length of the serialized form. Otherwise returns 0.
 * Results are cached per message object using a WeakMap.
 *
 * @param message - The message to estimate size for
 * @returns Size in bytes, or 0 if size cannot be determined
 */
export function estimateMessageSize(message: unknown): number {
    if (message == null) return 0;
    if (typeof message !== "object") return 0;

    const cached = sizeCache.get(message as object);
    if (cached !== undefined) return cached;

    if ("toBinary" in message && typeof (message as { toBinary: unknown }).toBinary === "function") {
        const size = (message as { toBinary(): Uint8Array }).toBinary().byteLength;
        sizeCache.set(message as object, size);
        return size;
    }
    return 0;
}

/**
 * Wraps an AsyncIterable to track streaming messages with OTel span events.
 *
 * Captures the span via closure (not AsyncLocalStorage) to avoid
 * the Node.js ALS context loss in async generators (nodejs/node#42237).
 *
 * When `endSpanOnComplete` is true, the span lifecycle is managed by the
 * generator itself: the span is ended in the `finally` block, which runs
 * on normal completion, error, or early break (generator.return()).
 *
 * @param iterable - The source async iterable (streaming messages)
 * @param span - The OTel span to record events on
 * @param direction - 'SENT' for outgoing, 'RECEIVED' for incoming messages
 * @param recordMessages - Whether to record individual message events
 * @param endSpanOnComplete - Whether to end the span when the stream completes
 * @returns A new AsyncGenerator that yields the same messages with span events
 */
export async function* wrapAsyncIterable<T>(
    iterable: AsyncIterable<T>,
    span: Span,
    direction: "SENT" | "RECEIVED",
    recordMessages: boolean,
    endSpanOnComplete = false,
): AsyncGenerator<T> {
    let sequence = 1;
    let streamError: unknown;
    try {
        for await (const message of iterable) {
            if (recordMessages) {
                span.addEvent(RPC_MESSAGE_EVENT, {
                    [ATTR_RPC_MESSAGE_TYPE]: direction,
                    [ATTR_RPC_MESSAGE_ID]: sequence,
                    [ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]: estimateMessageSize(message),
                });
            }
            sequence++;
            yield message;
        }
    } catch (error) {
        streamError = error;
        throw error;
    } finally {
        if (endSpanOnComplete) {
            if (streamError) {
                span.recordException(streamError as Error);
                const message = streamError instanceof Error ? streamError.message : String(streamError);
                span.setStatus({ code: SpanStatusCode.ERROR, message });
            } else {
                span.setStatus({ code: SpanStatusCode.OK });
            }
            span.end();
        }
    }
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
        // NOTE: HTTP/3 (QUIC) uses "udp" transport; update when QUIC support is added
        [ATTR_NETWORK_TRANSPORT]: "tcp",
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

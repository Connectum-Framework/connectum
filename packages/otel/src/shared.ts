/**
 * Shared utilities for server and client OTel interceptors
 *
 * Contains common helper functions used by both createOtelInterceptor()
 * and createOtelClientInterceptor().
 *
 * @module shared
 */

import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { toBinary } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import type { Attributes, Context, Span } from "@opentelemetry/api";
import { context, diag, INVALID_SPAN_CONTEXT, trace } from "@opentelemetry/api";

import {
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_PROTOCOL_NAME,
    ATTR_NETWORK_TRANSPORT,
    ATTR_RPC_MESSAGE_ID,
    ATTR_RPC_MESSAGE_TYPE,
    ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE,
    ATTR_RPC_METHOD,
    ATTR_RPC_RESPONSE_STATUS_CODE,
    ATTR_RPC_SYSTEM_NAME,
    ATTR_SERVER_ADDRESS,
    ATTR_SERVER_PORT,
    CONNECTUM_INTERNAL_TRANSPORT_HEADER,
    CONNECTUM_INTERNAL_TRANSPORT_IN_PROCESS,
    ConnectErrorCodeName,
    RPC_MESSAGE_EVENT,
    RPC_SYSTEM_NAME_CONNECTRPC,
} from "./attributes.ts";
import { describeThrown, recordFailure } from "./failure.ts";
import { hasProvider } from "./provider.ts";
import type { OtelAttributeFilter, OtelFilter } from "./types.ts";

/** Well-known `error.type` value for an error that the instrumentation cannot name better. */
const ERROR_TYPE_OTHER = "_OTHER";

/**
 * Estimates the serialized size of a protobuf message in bytes.
 *
 * With the message's `schema` (for a call, `method.input` or `method.output`), the size
 * is the byte length of `toBinary(schema, message)` from `@bufbuild/protobuf`: a
 * protobuf-es v2 message is a plain object and has no `toBinary()` method of its own.
 * Without a schema, or when the message cannot be serialized with it, a message that
 * exposes a `toBinary()` method (the protobuf-es v1 API) is measured with that method.
 * Otherwise the result is 0, and so it is for a message that fails to serialize: the
 * estimate must never fail the observed call.
 * The size is not remembered per message object: a message is mutable and an application
 * may reuse one object across calls, so every estimate measures the message as it is.
 *
 * @param message - The message to estimate size for
 * @param schema - The descriptor of the message type, when known
 * @returns Size in bytes, or 0 if size cannot be determined
 */
export function estimateMessageSize(message: unknown, schema?: DescMessage): number {
    if (message === null || message === undefined) return 0;
    if (typeof message !== "object") return 0;

    let size: number | undefined;
    if (schema !== undefined) {
        try {
            size = toBinary(schema, message as MessageShape<DescMessage>).byteLength;
        } catch {
            // Not a message of this schema (a plain object, a partially built message):
            // fall back to the message's own method below.
        }
    }
    if (size === undefined && "toBinary" in message && typeof (message as { toBinary: unknown }).toBinary === "function") {
        try {
            size = (message as { toBinary(): Uint8Array }).toBinary().byteLength;
        } catch {
            // A message that cannot be serialized has no size to report.
        }
    }
    return size ?? 0;
}

/** Options of {@link wrapAsyncIterable} beyond the span and the direction. */
export interface StreamOptions {
    /** Descriptor of the stream's message type; event sizes are the serialized length under it. */
    schema?: DescMessage;
    /**
     * Called once when a stream that ends its span ends: after the last message, after an
     * error, or when the consumer stops reading. It runs before the span ends, so it can
     * still put attributes on the span, and it takes over the recording of a failure
     * (without it the failure is recorded on the span as is). An exception it throws is
     * swallowed: telemetry must not change what the consumer of the stream receives.
     */
    onEnd?: (outcome: StreamOutcome) => void;
}

/** How a stream ended: `failed` is true for an error raised by the source, whatever its value. */
export type StreamOutcome = { failed: false } | { failed: true; error: unknown };

/**
 * Wraps an AsyncIterable to track streaming messages with OTel span events.
 *
 * Captures the span via closure (not AsyncLocalStorage) to avoid
 * the Node.js ALS context loss in async generators (nodejs/node#42237).
 * Recording events this way does not make the span the active span for the
 * code that produces the messages; use {@link scopeAsyncIterable} for that.
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
 * @param streamOptions - The message type of the stream and the end-of-stream hook
 * @returns A new AsyncGenerator that yields the same messages with span events
 */
export async function* wrapAsyncIterable<T>(
    iterable: AsyncIterable<T>,
    span: Span,
    direction: "SENT" | "RECEIVED",
    recordMessages: boolean,
    endSpanOnComplete = false,
    streamOptions: StreamOptions = {},
): AsyncGenerator<T> {
    const { schema, onEnd } = streamOptions;
    let sequence = 1;
    // Whether the stream raised is tracked apart from the raised value: the value
    // may be falsy (`null`, `0`, `""`) and must still count as a failure.
    let failed = false;
    let streamError: unknown;
    try {
        for await (const message of iterable) {
            if (recordMessages) {
                span.addEvent(RPC_MESSAGE_EVENT, {
                    [ATTR_RPC_MESSAGE_TYPE]: direction,
                    [ATTR_RPC_MESSAGE_ID]: sequence,
                    [ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]: estimateMessageSize(message, schema),
                });
            }
            sequence++;
            yield message;
        }
    } catch (error) {
        failed = true;
        streamError = error;
        throw error;
    } finally {
        if (endSpanOnComplete) {
            if (onEnd) {
                try {
                    onEnd(failed ? { failed: true, error: streamError } : { failed: false });
                } catch {
                    // Intentionally empty: see StreamOptions.onEnd.
                }
            } else if (failed) {
                recordFailure(span, streamError);
            }
            // Normal completion and an early exit of the consumer both leave the
            // status unset: the instrumentation never reports OK, and a consumer
            // that stops reading is not a failure.
            span.end();
        }
    }
}

/**
 * Runs every step of an async iterable inside a fixed OpenTelemetry context.
 *
 * A streaming handler is an async generator whose body does not run when the
 * interceptor returns the response: it runs later, step by step, each time the
 * transport pulls the next message. By then `startActiveSpan` has already
 * returned, so without this scope the handler runs with whatever context the
 * puller happens to have and `trace.getActiveSpan()` is empty. Creating the
 * iterator and calling `next()`, `return()` and `throw()` under `scope` makes
 * the span in `scope` the active span for the handler's code, including its
 * `finally` block, and parents any span the handler starts to it.
 *
 * The scope covers only the synchronous start of each step and the
 * continuations that start from it. It is never entered permanently: the code
 * that called `next()` keeps its own context once the call returns. The
 * returned iterator holds `scope` for as long as the iterator itself is
 * reachable. Only the steps taken through the returned iterator are scoped:
 * code that finishes the underlying generator directly (calling `return()` on
 * it, not on the returned iterator) bypasses the scope.
 *
 * @param iterable - The iterable whose steps must run inside `scope`
 * @param scope - The context to run each step in (carrying the active span)
 * @returns An iterable producing the same values, with every step run in `scope`
 */
export function scopeAsyncIterable<T>(iterable: AsyncIterable<T>, scope: Context): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            const iterator = context.with(scope, () => iterable[Symbol.asyncIterator]());
            const scoped: AsyncIterator<T> = {
                next: (...args) => context.with(scope, () => iterator.next(...args)),
            };
            // `return` and `throw` are optional in the protocol; mirror their
            // absence so a consumer that probes for them sees the source's shape.
            if (iterator.return) {
                const sourceReturn = iterator.return.bind(iterator);
                scoped.return = (value) => context.with(scope, () => sourceReturn(value));
            }
            if (iterator.throw) {
                const sourceThrow = iterator.throw.bind(iterator);
                scoped.throw = (error) => context.with(scope, () => sourceThrow(error));
            }
            return scoped;
        },
    };
}

/**
 * Class name of an error for `error.type`: the constructor name, then the error's own
 * `name` when the class is anonymous, then `_OTHER`, the fallback value the semantic
 * conventions define for an error that has no better identifier. Never empty.
 */
function errorClassName(error: Error): string {
    const className = error.constructor?.name;
    if (typeof className === "string" && className !== "") return className;
    const name = error.name;
    if (typeof name === "string" && name !== "") return name;
    return ERROR_TYPE_OTHER;
}

/**
 * Builds error-specific attributes for spans and metrics.
 *
 * For ConnectError instances, `error.type` and `rpc.response.status_code` both carry the
 * Connect error-code name (the convention asks `error.type` to be the status code).
 * For generic Error instances, records the error constructor name as `error.type` only;
 * an anonymous class falls back to the error's `name`, then to `_OTHER`.
 * For unknown error types, records "UNKNOWN".
 *
 * @param error - The caught error
 * @returns Record of error attributes to attach to spans/metrics
 */
export function buildErrorAttributes(error: unknown): Record<string, string> {
    const attrs: Record<string, string> = {};
    try {
        if (error instanceof ConnectError) {
            const name = ConnectErrorCodeName[error.code] ?? "UNKNOWN";
            attrs[ATTR_ERROR_TYPE] = name;
            attrs[ATTR_RPC_RESPONSE_STATUS_CODE] = name;
        } else if (error instanceof Error) {
            attrs[ATTR_ERROR_TYPE] = errorClassName(error);
        } else {
            attrs[ATTR_ERROR_TYPE] = "UNKNOWN";
        }
    } catch {
        // A thrown value can be hostile: a revoked proxy makes `instanceof` throw, and an
        // error can have a `constructor` getter that throws. The attributes describe the
        // failure, they must not replace it, so the error is reported as unidentifiable.
        return { [ATTR_ERROR_TYPE]: ERROR_TYPE_OTHER };
    }
    return attrs;
}

/**
 * Connect error codes that the OpenTelemetry Connect RPC conventions treat as errors of a
 * server span: unknown, deadline_exceeded, unimplemented, internal, unavailable, data_loss.
 * Any other code (not_found, invalid_argument, canceled, ...) is the caller's outcome, not
 * a failure of the server, and leaves the span status unset. The numbers are the Connect
 * protocol's error codes.
 */
const SERVER_ERROR_CODES: ReadonlySet<number> = new Set([2, 4, 12, 13, 14, 15]);

/**
 * Whether an error that ended a call counts as an error of its server span. An error that
 * is not a `ConnectError` is turned into `unknown` by the server and counts.
 *
 * @param error - The error, exactly as caught
 */
export function isServerErrorStatus(error: unknown): boolean {
    try {
        return !(error instanceof ConnectError) || SERVER_ERROR_CODES.has(error.code);
    } catch {
        // An unreadable thrown value (a revoked proxy) is not a code the caller chose.
        return true;
    }
}

/**
 * Marks a span as failed by the error a call ended with: the failure itself (status and
 * exception, see `recordFailure`) and the error attributes of {@link buildErrorAttributes}.
 * The span status becomes `ERROR` for every failure of a client span, and for a server span
 * only when {@link isServerErrorStatus} says so. It does not end the span. Never throws.
 *
 * @param span - The span of the call
 * @param error - The error, exactly as caught
 * @param side - Which side of the call the span belongs to
 * @returns The error attributes, for the metric points of the same call
 */
export function markSpanFailed(span: Span, error: unknown, side: "server" | "client"): Record<string, string> {
    const errorAttrs = buildErrorAttributes(error);
    recordFailure(span, error, side === "client" || isServerErrorStatus(error));
    try {
        span.setAttributes(errorAttrs);
    } catch {
        // Intentionally empty: a failing exporter-side hook must not replace the call's error.
    }
    return errorAttrs;
}

/** A span that records nothing, for the code paths that observe a call without a trace. */
export const NON_RECORDING_SPAN: Span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/**
 * Attributes of a successfully completed unary call: `rpc.response.status_code="OK"`.
 * `error.type` is deliberately absent, the convention forbids it on success.
 */
export function buildSuccessAttributes(): Record<string, string> {
    return { [ATTR_RPC_RESPONSE_STATUS_CODE]: "OK" };
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
        [ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
        [ATTR_RPC_METHOD]: `${params.service}/${params.method}`,
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
 * Connectum transport identifier observed from request headers.
 *
 * `@connectum/core`'s `createLocalTransport` sets a synthetic request header
 * (`connectum-internal-transport: in-process`) on every outgoing call so that
 * the OTel interceptors can tag spans and metrics with the originating
 * transport without parsing the synthetic `https://in-memory/...` URL.
 *
 * @param headers - The request headers (Connect `req.header`)
 * @returns `"in-process"` if the marker is present, `"http"` otherwise.
 */
export function detectConnectumTransport(headers: Headers): "in-process" | "http" {
    return headers.get(CONNECTUM_INTERNAL_TRANSPORT_HEADER) === CONNECTUM_INTERNAL_TRANSPORT_IN_PROCESS ? "in-process" : "http";
}

/** Reports the failure of a user callback; see {@link createHookFailureReporter}. */
export type HookFailureReporter = (hook: "filter" | "attributeFilter", error: unknown) => void;

/**
 * Creates the reporter an interceptor uses when one of its user callbacks (`filter`,
 * `attributeFilter`) throws.
 *
 * The callback is the application's code on the path of every RPC: its bug must not
 * fail the call, so the interceptor goes on and reports the error through the
 * OpenTelemetry diagnostics channel (`diag`), which has no output until the
 * application or `initProvider()` registers a logger. A callback that is broken for
 * every call would otherwise flood the log, so each callback is reported once per
 * owner. The reporter never throws.
 *
 * @param owner - What the reporter belongs to, named in the message ("the server interceptor")
 * @returns The reporter
 */
export function createHookFailureReporter(owner: string): HookFailureReporter {
    const reported = new Set<string>();
    return (hook, error) => {
        if (reported.has(hook)) return;
        const consequence = hook === "filter" ? "the call is instrumented" : "the attribute it was asked about is not recorded";
        try {
            // The provider registers the diagnostics logger when it is created, and the
            // callbacks run before the tracer and the meter are first used. A report made
            // before the provider exists would go nowhere, and would count as made, so it
            // waits: the callback fails again on the next call, by which time the call
            // before it has created the provider. Creating the provider here would start
            // the exporters of an application that has switched instrumentation off.
            if (!hasProvider()) return;
            reported.add(hook);
            diag.error(`@connectum/otel: the ${hook} option of ${owner} threw, ${consequence} (reported once per ${owner}): ${describeThrown(error)}`);
        } catch {
            // Intentionally empty: a failing diagnostics logger must not fail the call either.
        }
    };
}

/** Reporter for a direct call of {@link applyAttributeFilter} that passes none. */
const reportForDirectCaller = createHookFailureReporter("a caller of applyAttributeFilter");

/**
 * Asks the `filter` option whether a call is to be instrumented. A filter that throws
 * counts as "instrument": the failure is reported, the call is not affected, and
 * telemetry is not lost silently.
 *
 * @param filter - The user's filter, if any
 * @param call - The call the filter is asked about
 * @param report - Reporter for a throwing filter
 * @returns Whether to instrument the call
 */
export function shouldInstrument(filter: OtelFilter | undefined, call: { service: string; method: string; stream: boolean }, report: HookFailureReporter): boolean {
    if (!filter) return true;
    try {
        return Boolean(filter(call));
    } catch (error) {
        report("filter", error);
        return true;
    }
}

/**
 * Applies an attribute filter to the given attributes.
 *
 * An attribute is kept only if the filter approves it, so a filter that throws for an
 * attribute drops that attribute (the failure is reported, the call is not affected).
 *
 * @param attrs - Base attributes to filter
 * @param filter - Optional filter function
 * @param report - Reporter for a throwing filter; the interceptors pass their own, a direct caller gets one report per process
 * @returns Filtered attributes
 */
export function applyAttributeFilter(attrs: Record<string, string | number>, filter?: OtelAttributeFilter, report: HookFailureReporter = reportForDirectCaller): Attributes {
    if (!filter) return attrs;
    return Object.fromEntries(
        Object.entries(attrs).filter(([key, value]) => {
            try {
                return filter(key, value);
            } catch (error) {
                report("attributeFilter", error);
                return false;
            }
        }),
    );
}

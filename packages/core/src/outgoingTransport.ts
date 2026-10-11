/**
 * Outgoing-policy transport decorator.
 *
 * `createServer({ outgoingInterceptors })` promises one client-side chain for
 * every catalog call. The in-process route can take that chain natively
 * (`createLocalTransport` builds its own Connect pipeline), but a resolver
 * returns an already constructed, opaque `Transport` whose interceptor list is
 * fixed at construction. This module wraps such a transport so the chain runs
 * around every `unary`/`stream` call it makes — once per call, outside the
 * transport's own middleware, with the deadline budget started before the
 * first interceptor runs.
 *
 * @module outgoingTransport
 */

import type { DescMessage, DescMethodStreaming, DescMethodUnary, MessageInitShape } from "@bufbuild/protobuf";
import type { ContextValues, Interceptor, StreamResponse, Transport, UnaryResponse } from "@connectrpc/connect";
import { createContextValues } from "@connectrpc/connect";
import { createMethodUrl, runStreamingCall, runUnaryCall } from "@connectrpc/connect/protocol";

/**
 * Origin of the synthetic `req.url` an outgoing interceptor observes on a
 * resolver route. A `Transport` does not expose the address it dials, so the
 * decorator cannot report the wire URL; it reports a stable, documented one
 * instead (`https://catalog/<typeName>/<Method>`), the same way Connect's
 * router transport reports `https://in-memory/...` for in-process calls.
 * The transport's own interceptors, which run inside, still see the wire URL.
 */
export const OUTGOING_TRANSPORT_ORIGIN = "https://catalog";

/**
 * Milliseconds left until `deadline` (a `performance.now()` timestamp), never
 * negative. `undefined` when there is no deadline.
 */
function remainingMs(deadline: number | undefined): number | undefined {
    if (deadline === undefined) return undefined;
    // Whole milliseconds: the Connect and gRPC timeout headers reject fractions.
    // Never 0: a Connect transport reads `timeoutMs <= 0` as "no deadline", and
    // an exhausted budget must still reach the wire as a deadline (1 ms) while
    // the outer deadline signal, already due, cancels the call.
    return Math.max(1, Math.ceil(deadline - performance.now()));
}

/**
 * The deadline the chain runs under. `timeoutMs <= 0` means "no deadline" on
 * every Connect transport (`createTransport` normalizes it to `undefined`), so
 * the decorator reads it the same way instead of expiring the call at once.
 */
function callDeadline(timeoutMs: number | undefined): { timeoutMs: number | undefined; deadline: number | undefined } {
    if (timeoutMs === undefined || timeoutMs <= 0) return { timeoutMs: undefined, deadline: undefined };
    return { timeoutMs, deadline: performance.now() + timeoutMs };
}

/**
 * Wrap `transport` so that `interceptors` run around each of its calls.
 *
 * Returns `transport` itself when the chain is empty, so a server or client
 * without outgoing policy keeps the exact transport its resolver returned.
 *
 * Contract observed by the chain (identical to a chain mounted on a Connect
 * transport, except for `url`):
 * - the chain runs in source order, the first interceptor outermost;
 * - `req.signal` is linked to the caller's signal and to the call deadline,
 *   so an interceptor sees cancellation and expiry exactly as on a native
 *   transport;
 * - the deadline starts before the first interceptor runs: the inner transport
 *   receives only the budget that is still left when the chain reaches it, so
 *   a slow interceptor (an async token factory, say) cannot extend the call;
 * - `req.header`, `req.message` and `req.contextValues` are handed to the inner
 *   transport as the chain leaves them, so headers set by the chain reach the
 *   wire and the handler context values keep their identity;
 * - `req.url` is `https://catalog/<typeName>/<Method>` and `req.requestMethod`
 *   is `"POST"`; the inner transport decides the real wire URL and method
 *   (Connect GET for idempotent methods, for example) on its own.
 */
export function withOutgoingInterceptors(transport: Transport, interceptors: readonly Interceptor[]): Transport {
    if (interceptors.length === 0) return transport;
    const chain = [...interceptors];
    return {
        unary<I extends DescMessage, O extends DescMessage>(
            method: DescMethodUnary<I, O>,
            signal: AbortSignal | undefined,
            timeoutMs: number | undefined,
            header: HeadersInit | undefined,
            input: MessageInitShape<I>,
            contextValues?: ContextValues,
        ): Promise<UnaryResponse<I, O>> {
            const budget = callDeadline(timeoutMs);
            return runUnaryCall<I, O>({
                interceptors: chain,
                ...(signal !== undefined ? { signal } : {}),
                ...(budget.timeoutMs !== undefined ? { timeoutMs: budget.timeoutMs } : {}),
                req: {
                    stream: false,
                    service: method.parent,
                    method,
                    requestMethod: "POST",
                    url: createMethodUrl(OUTGOING_TRANSPORT_ORIGIN, method),
                    header: new Headers(header),
                    contextValues: contextValues ?? createContextValues(),
                    message: input,
                },
                next: (req) => transport.unary(req.method, req.signal, remainingMs(budget.deadline), req.header, req.message, req.contextValues),
            });
        },
        stream<I extends DescMessage, O extends DescMessage>(
            method: DescMethodStreaming<I, O>,
            signal: AbortSignal | undefined,
            timeoutMs: number | undefined,
            header: HeadersInit | undefined,
            input: AsyncIterable<MessageInitShape<I>>,
            contextValues?: ContextValues,
        ): Promise<StreamResponse<I, O>> {
            const budget = callDeadline(timeoutMs);
            return runStreamingCall<I, O>({
                interceptors: chain,
                ...(signal !== undefined ? { signal } : {}),
                ...(budget.timeoutMs !== undefined ? { timeoutMs: budget.timeoutMs } : {}),
                req: {
                    stream: true,
                    service: method.parent,
                    method,
                    requestMethod: "POST",
                    url: createMethodUrl(OUTGOING_TRANSPORT_ORIGIN, method),
                    header: new Headers(header),
                    contextValues: contextValues ?? createContextValues(),
                    message: input,
                },
                next: (req) => transport.stream(req.method, req.signal, remainingMs(budget.deadline), req.header, req.message, req.contextValues),
            });
        },
    };
}

/**
 * In-process ConnectRPC transport.
 *
 * Wraps `createRouterTransport` from `@connectrpc/connect` over the already
 * registered routes of a Connectum `Server`, dispatching calls directly to
 * handler functions without opening an HTTP/2 socket.
 *
 * @module localTransport
 */

import { AsyncResource } from "node:async_hooks";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { createRouterTransport } from "@connectrpc/connect";
import { finishStreamOnAbort } from "./finishStreamOnAbort.ts";
import type { CreateServerOptions, Server } from "./types.ts";

/**
 * Internal request-header marker used by `@connectum/otel` (and any other
 * cross-cutting interceptor) to distinguish the in-process pipe from the
 * HTTP transport without parsing the synthetic `req.url`.
 *
 * The marker is set by an interceptor that is prepended to the client-side
 * chain of `createLocalTransport`, so it is observable by both the client
 * and the server interceptor chain. It is stripped/normalised by parity
 * tests when diffing observable behaviour.
 *
 * SECURITY: inbound HTTP requests have this header deleted before
 * `connectNodeAdapter` builds the request (see `buildRoutes`), so neither a
 * `requestGate` nor a server interceptor can observe a forged value; an
 * HTTP-only interceptor strips it again as defense in depth. Legitimate
 * in-process calls bypass `connectNodeAdapter` entirely, so the marker
 * remains intact for them. It exists for logging and telemetry attribution
 * only and must not be used to exempt calls from a gate or authorization:
 * the in-process path deliberately admits requests exactly like HTTP.
 * Treat this constant as framework-internal — it is
 * deliberately not re-exported from `@connectum/core`'s public `index.ts`.
 *
 * @internal
 */
export const LOCAL_TRANSPORT_HEADER = "connectum-internal-transport";
/**
 * Value placed in {@link LOCAL_TRANSPORT_HEADER} by `createLocalTransport`.
 *
 * @internal
 */
export const LOCAL_TRANSPORT_VALUE = "in-process";

/**
 * Options for {@link createLocalTransport}.
 */
export interface CreateLocalTransportOptions {
    /**
     * Client-side interceptors applied to outbound calls before they reach
     * the registered handlers. Server-side interceptors configured on the
     * `Server` instance still run inside the handler chain — these are
     * additive and run on the client side of the in-memory pipe.
     */
    interceptors?: Interceptor[];
}

/**
 * Internal interceptor that tags every outbound request with the local
 * transport marker header. Prepended to the user-supplied client-side
 * interceptors so it is visible to all downstream interceptors and to the
 * server-side chain.
 */
const localTransportMarkerInterceptor: Interceptor = (next) => (req) => {
    req.header.set(LOCAL_TRANSPORT_HEADER, LOCAL_TRANSPORT_VALUE);
    return next(req);
};

/**
 * Internal interceptor that keeps the caller's request stream in the caller's
 * async context.
 *
 * Over HTTP the client transport pumps the request messages of a
 * client-streaming or bidirectional call into the socket, so the caller's
 * generator runs in the context of the call site. In-process there is no
 * pump: the server-side handler pulls the caller's generator from inside its
 * own code, which runs under whatever a server interceptor scoped around the
 * handler (a verified identity, a trace, a tenant). The caller's generator
 * would then observe the server's values instead of its own. Binding every
 * step of the request iterator (creation, `next`, `return`, `throw`) to the
 * context captured here gives the generator the context it has over HTTP.
 *
 * Appended after the user-supplied client interceptors so the captured
 * context is the innermost client-side one, as it is over HTTP, where the
 * pump starts inside the transport below the whole client chain.
 */
const callerRequestContextInterceptor: Interceptor = (next) => (req) => {
    if (!req.stream) {
        return next(req);
    }
    const source = req.message;
    const scope = new AsyncResource("createLocalTransport.request");
    const bound: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
            const iterator = scope.runInAsyncScope(() => source[Symbol.asyncIterator]());
            const result: AsyncIterator<unknown> = {
                next: scope.bind((...args: [] | [unknown]) => iterator.next(...args)),
            };
            if (iterator.return) {
                const forward = iterator.return;
                result.return = scope.bind((...args: [] | [unknown]) => forward.apply(iterator, args));
            }
            if (iterator.throw) {
                const forward = iterator.throw;
                result.throw = scope.bind((...args: [] | [unknown]) => forward.apply(iterator, args));
            }
            return result;
        },
    };
    return next(Object.assign(Object.create(Object.getPrototypeOf(req)), req, { message: bound }));
};

/**
 * Server-internal accessor surface — implemented by `ServerImpl`. We re-declare
 * the shape here (rather than exporting a public mixin) so that the contract
 * stays internal to `@connectum/core`.
 */
interface ServerInternals {
    _getRoutesCallback(): Parameters<typeof createRouterTransport>[0];
    _getServerInterceptors(): Interceptor[];
    _getAdmissionOptions(): Pick<CreateServerOptions, "requestGate" | "readMaxBytes">;
}

function asInternals(server: Server): ServerInternals {
    const candidate = server as unknown as Partial<ServerInternals>;
    if (typeof candidate._getRoutesCallback !== "function" || typeof candidate._getServerInterceptors !== "function" || typeof candidate._getAdmissionOptions !== "function") {
        throw new TypeError("createLocalTransport: argument is not a Connectum Server instance (missing internal accessors).");
    }
    return candidate as ServerInternals;
}

/**
 * Create an in-process ConnectRPC `Transport` over the services already
 * registered on the given Connectum `Server`.
 *
 * The transport is safe to use before `server.start()` — it never opens a
 * TCP/UDP port or HTTP/2 session. Server-side interceptors configured via
 * `createServer({ interceptors })` are applied inside the handler chain;
 * `options.interceptors` are applied on the client side of the call.
 *
 * Headers are propagated via `Headers` objects through the in-memory pipe;
 * the wrapped `createRouterTransport` already clones headers at the call
 * boundary, providing mutation isolation between client and server.
 *
 * Cancellation: a streaming call is cancelled by the `AbortSignal` passed in
 * the call options, by its deadline, or by `server.stop()`. The handler's
 * `ctx.signal` aborts and its output generator is finished, so a handler
 * parked at `yield` runs its `finally`. Leaving a `for await` loop with
 * `break` is not a cancellation: the handler keeps running until one of the
 * above happens.
 *
 * Request streams: the caller's request stream of a client-streaming or
 * bidirectional call is advanced in the caller's async context, below the
 * client-side interceptors, as it is over HTTP, not in the handler's. The
 * caller's generator therefore observes the caller's own `AsyncLocalStorage`
 * values (identity, trace, application values) and never the ones a
 * server-side interceptor scoped around the handler. On cancellation its
 * `return`/`throw` run in the context that raised the abort, on both
 * transports.
 *
 * The synthetic origin observed by interceptors reading `req.url` is
 * `https://in-memory/<service>/<method>` (set by the underlying ConnectRPC
 * router transport — see `@connectrpc/connect`'s `router-transport.ts`).
 *
 * @param server - A server created via `createServer({...})`.
 * @param options - Optional client-side interceptors.
 * @returns A ConnectRPC `Transport` suitable for `createClient(service, transport)`.
 */
export function createLocalTransport(server: Server, options?: CreateLocalTransportOptions): Transport {
    const internals = asInternals(server);
    const routes = internals._getRoutesCallback();
    const serverInterceptors = internals._getServerInterceptors();
    return createRouterTransport(routes, {
        transport: {
            // The marker interceptor MUST run first so that user-supplied
            // client interceptors and the server-side chain both observe
            // `connectum-internal-transport: in-process` on the request
            // headers. The in-process path does NOT pass through
            // `connectNodeAdapter` and therefore is never touched by the
            // HTTP-only strip interceptor in `buildRoutes`, so the marker
            // survives end-to-end on legitimate local calls (and OTel can
            // attribute the call as `connectum.transport=in-process`).
            // Conversely, forged markers arriving over HTTP are stripped
            // before any server-side interceptor observes them.
            //
            // `callerRequestContextInterceptor` goes last: the context it binds
            // the caller's request stream to must be the one below every
            // client-side interceptor, as the HTTP pump's is.
            interceptors: [localTransportMarkerInterceptor, ...(options?.interceptors ?? []), callerRequestContextInterceptor],
        },
        router: {
            // Apply server-side interceptors identically to how the HTTP
            // path applies them via connectNodeAdapter — this preserves the
            // cross-transport parity invariant (interceptors, error mapping,
            // coexistence).
            //
            // `finishStreamOnAbort` goes last, next to the handler, exactly as
            // on the HTTP path: in-process nothing writes to a socket, so a
            // stream parked at `yield` would never reach its `finally` without
            // it.
            interceptors: [...serverInterceptors, finishStreamOnAbort],
            // The same shutdown signal the HTTP adapter gets: `server.stop()`
            // aborts `context.signal` of in-flight local calls (handlers,
            // pending request gates, streams) exactly as it does for HTTP
            // calls, so cooperative cleanup code runs on both transports.
            shutdownSignal: server.shutdownSignal,
            // The same server-level `requestGate` / `readMaxBytes` defaults
            // the HTTP adapter gets: a request is admitted or rejected the
            // same way whichever transport carries it, and service-level
            // options override both identically.
            ...internals._getAdmissionOptions(),
        },
    });
}

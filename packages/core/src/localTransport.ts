/**
 * In-process ConnectRPC transport.
 *
 * Wraps `createRouterTransport` from `@connectrpc/connect` over the already
 * registered routes of a Connectum `Server`, dispatching calls directly to
 * handler functions without opening an HTTP/2 socket.
 *
 * @module localTransport
 */

import type { Interceptor, Transport } from "@connectrpc/connect";
import { createRouterTransport } from "@connectrpc/connect";
import type { Server } from "./types.ts";

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
 * SECURITY: this header is stripped from inbound HTTP requests by an
 * interceptor in `buildRoutes` (HTTP path only). Legitimate in-process
 * calls bypass `connectNodeAdapter` entirely, so the marker remains
 * intact for them. Treat this constant as framework-internal — it is
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
 * Server-internal accessor surface — implemented by `ServerImpl`. We re-declare
 * the shape here (rather than exporting a public mixin) so that the contract
 * stays internal to `@connectum/core`.
 */
interface ServerInternals {
    _getRoutesCallback(): Parameters<typeof createRouterTransport>[0];
    _getServerInterceptors(): Interceptor[];
}

function asInternals(server: Server): ServerInternals {
    const candidate = server as unknown as Partial<ServerInternals>;
    if (typeof candidate._getRoutesCallback !== "function" || typeof candidate._getServerInterceptors !== "function") {
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
            interceptors: [localTransportMarkerInterceptor, ...(options?.interceptors ?? [])],
        },
        router: {
            // Apply server-side interceptors identically to how the HTTP
            // path applies them via connectNodeAdapter — this preserves the
            // cross-transport parity invariant required by Phase 4-A
            // (interceptors compatibility, error mapping, coexistence).
            interceptors: serverInterceptors,
        },
    });
}

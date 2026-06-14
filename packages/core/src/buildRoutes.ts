/**
 * Route builder
 *
 * Composes services, protocols, and interceptors into a ConnectRPC handler.
 * Collects service DescFile registry for protocol use (reflection, etc).
 *
 * @module buildRoutes
 */

import type { DescFile, JsonReadOptions, JsonWriteOptions } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { LOCAL_TRANSPORT_HEADER } from "./localTransport.ts";
import type { NodeRequest, NodeResponse, ProtocolContext, ProtocolRegistration, ServiceRoute } from "./types.ts";

/**
 * Server-side interceptor applied ONLY on the HTTP entry path (via
 * `connectNodeAdapter`). Strips the `connectum-internal-transport` request
 * header before it reaches the user interceptor chain or the OTel
 * server-side interceptor.
 *
 * Rationale (security finding F1, CWE-345): the header is set by
 * `createLocalTransport`'s client-side marker interceptor to disambiguate
 * the in-memory pipe from HTTP transport. The marker is consumed by
 * `@connectum/otel` to tag spans/metrics with `connectum.transport=in-process`.
 * Because the constant name is published, a remote HTTP caller could forge
 * the header and poison telemetry. Stripping inbound HTTP-side ensures the
 * marker can only originate from a legitimate in-process pipe (whose path
 * never traverses this HTTP-only interceptor).
 *
 * The in-process path (`createLocalTransport`) does NOT pass through this
 * interceptor: it builds its own `createRouterTransport` directly over the
 * route callback, with the marker interceptor prepended on the client side.
 * Therefore legitimate in-process calls still carry the marker into the
 * server interceptor chain (and OTel observes it correctly), while forged
 * HTTP calls have the header neutralised here.
 *
 * @internal
 */
const stripLocalTransportHeaderOnHttp: Interceptor = (next) => (req) => {
    req.header.delete(LOCAL_TRANSPORT_HEADER);
    return next(req);
};

/**
 * Options for building routes
 */
export interface BuildRoutesOptions {
    services: ServiceRoute[];
    protocols: ProtocolRegistration[];
    interceptors: Interceptor[];
    shutdownSignal: AbortSignal;
    /** Connect JSON serialization options applied server-wide (passed to connectNodeAdapter). */
    jsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>;
}

/**
 * Result of building routes
 */
export interface BuildRoutesResult {
    handler: (req: NodeRequest, res: NodeResponse) => void;
    registry: DescFile[];
    /**
     * The ConnectRouter setup callback that registers all services + protocols.
     *
     * Exposed so consumers (e.g. in-process transport) can pass the same
     * route registration to `createRouterTransport` from `@connectrpc/connect`
     * without spinning up an HTTP/2 socket.
     *
     * @internal
     */
    routes: (router: ConnectRouter) => void;
    /**
     * Set of `DescService.typeName` strings that were actually registered via
     * `router.service(desc, impl)` during materialization (user services and
     * protocol-provided services). Drives automatic local/remote routing in
     * `Server.client()` / `Server.hasService()`.
     *
     * @internal
     */
    registeredServiceTypeNames: Set<string>;
    /**
     * The prefix of `registry` contributed by user services (before protocol
     * registration). Transport validation runs against this slice only:
     * protocol-contributed services (e.g. gRPC Reflection, whose
     * ServerReflectionInfo is bidi) own their documented transport
     * limitations and must not fail the user's startup.
     */
    userRegistry: DescFile[];
}

/**
 * Compose services, protocols, and interceptors into a ConnectRPC request handler.
 *
 * Intercepts `router.service()` calls to collect DescFile descriptors into a registry,
 * then registers user services and protocol services, and finally creates the
 * connectNodeAdapter with fallback routing to protocol HTTP handlers.
 *
 * @param options - Services, protocols, interceptors, and shutdown signal
 * @returns The HTTP handler and collected DescFile registry
 */
export function buildRoutes(options: BuildRoutesOptions): BuildRoutesResult {
    const { services, protocols, interceptors, shutdownSignal, jsonOptions } = options;

    const registry: DescFile[] = [];
    const registeredServiceTypeNames = new Set<string>();
    let userFileCount = 0;

    // Setup routes with registry interceptor.
    // Note: `routes` may be invoked more than once against different ConnectRouter
    // instances (HTTP adapter + in-process transport). Dedupe DescFile entries
    // so the shared `registry` reflects unique service files regardless of how
    // many routers we materialize.
    const routes = (router: ConnectRouter) => {
        // Intercept router.service() to collect DescFile[] and typeName registry
        const originalService = router.service;
        router.service = ((...args: Parameters<ConnectRouter["service"]>) => {
            const [service] = args;
            if (!registry.includes(service.file)) {
                registry.push(service.file);
            }
            registeredServiceTypeNames.add(service.typeName);
            return originalService.apply(router, args);
        }) as typeof originalService;

        // Register user services
        for (const serviceRoute of services) {
            serviceRoute(router);
        }
        // Everything registered up to here came from user services;
        // descriptors added below belong to protocols.
        userFileCount = registry.length;

        // Register protocols
        const context: ProtocolContext = { registry };
        for (const protocol of protocols) {
            protocol.register(router, context);
        }
    };

    // Collect HTTP handlers from protocols
    const httpHandlers = protocols.map((p) => p.httpHandler).filter((h) => h != null);

    // Create HTTP/2 server adapter.
    //
    // SECURITY: prepend the HTTP-only strip interceptor so that any forged
    // `connectum-internal-transport` header arriving over the wire is
    // neutralised before downstream interceptors (including OTel) observe it.
    // The in-process path bypasses `connectNodeAdapter` entirely and reuses
    // the route callback via `createRouterTransport`, so this interceptor
    // does NOT affect legitimate local invocations.
    const handler = connectNodeAdapter({
        routes,
        interceptors: [stripLocalTransportHeaderOnHttp, ...interceptors],
        shutdownSignal,
        ...(jsonOptions ? { jsonOptions } : {}),
        fallback(req, res) {
            // Delegate to protocol HTTP handlers
            for (const httpHandler of httpHandlers) {
                if (httpHandler(req as NodeRequest, res as NodeResponse)) {
                    return;
                }
            }

            // Default fallback
            res.statusCode = 404;
            res.end("Not Found");
        },
    });

    // connectNodeAdapter invokes routes() synchronously, so both the full
    // registry and the user-service prefix are populated at this point.
    return {
        handler: handler as (req: NodeRequest, res: NodeResponse) => void,
        registry,
        routes,
        registeredServiceTypeNames,
        userRegistry: registry.slice(0, userFileCount),
    };
}

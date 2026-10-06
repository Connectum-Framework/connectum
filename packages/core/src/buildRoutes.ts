/**
 * Route builder
 *
 * Composes services, protocols, and interceptors into a ConnectRPC handler.
 * Collects service DescFile registry for protocol use (reflection, etc).
 *
 * @module buildRoutes
 */

import type { DescFile, DescService, JsonReadOptions, JsonWriteOptions } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { RegisterContext, ServiceDefinition } from "./defineService.ts";
import { finishStreamOnAbort } from "./finishStreamOnAbort.ts";
import { LOCAL_TRANSPORT_HEADER } from "./localTransport.ts";
import type { CreateServerOptions, NodeRequest, NodeResponse, ProtocolContext, ProtocolRegistration } from "./types.ts";

/**
 * Second line of defense against a forged `connectum-internal-transport`
 * header on the HTTP entry path; the first line is the request wrapper in
 * {@link buildRoutes}, which deletes the header before `connectNodeAdapter`
 * ever builds the request.
 *
 * Why the header matters (CWE-345): `createLocalTransport` sets it to tell the
 * in-memory pipe apart from HTTP, and `@connectum/otel` and the logger use it
 * to attribute calls to `connectum.transport=in-process`. A remote caller who
 * knows the name could forge it and poison that attribution. This interceptor
 * keeps the guarantee for the interceptor chain even if a future change
 * bypasses the request wrapper.
 *
 * The in-process path never traverses `connectNodeAdapter`, so legitimate
 * local calls keep the marker end-to-end.
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
    services: readonly ServiceDefinition[];
    protocols: ProtocolRegistration[];
    interceptors: Interceptor[];
    shutdownSignal: AbortSignal;
    /**
     * Framework helpers handed to each service's `register` closure (wraps user
     * handlers so they receive the Connectum `Context` with `ctx.call`).
     */
    registerContext: RegisterContext;
    /** Connect JSON serialization options applied server-wide (passed to connectNodeAdapter). */
    jsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>;
    /** Server-level request gate default (passed to connectNodeAdapter). See {@link CreateServerOptions.requestGate}. */
    requestGate?: CreateServerOptions["requestGate"];
    /** Server-level per-message read limit default (passed to connectNodeAdapter). See {@link CreateServerOptions.readMaxBytes}. */
    readMaxBytes?: number;
    /**
     * Proto `typeName`s to mount locally. A service whose `typeName` is not in
     * the set is skipped (treated as remote). `undefined` mounts every service.
     */
    enabledServices?: readonly string[];
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
     * The services mounted by the application (before protocol registration),
     * in registration order. Transport validation runs against these only:
     * protocol-contributed services (e.g. gRPC Reflection, whose
     * ServerReflectionInfo is bidi) own their documented transport
     * limitations and must not fail the user's startup, and services that are
     * declared in a mounted file but not mounted cannot be called at all.
     */
    userServices: DescService[];
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
    const { services, protocols, interceptors, shutdownSignal, jsonOptions, requestGate, readMaxBytes, enabledServices, registerContext } = options;

    const registry: DescFile[] = [];
    const registeredServiceTypeNames = new Set<string>();
    // Every mounted service in registration order. `registry` holds their
    // files, and a file may also declare services that are not mounted.
    const mountedServices: DescService[] = [];
    let userServiceCount = 0;
    // Protocol `setup` is one-time work (health manager initialization,
    // reflection descriptor set) and must not run again for the routers
    // built later by in-process transports.
    let protocolsSetUp = false;

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
            if (!registeredServiceTypeNames.has(service.typeName)) {
                mountedServices.push(service);
            }
            registeredServiceTypeNames.add(service.typeName);
            return originalService.apply(router, args);
        }) as typeof originalService;

        // Register user services. With `enabledServices`, mount only the listed
        // typeNames locally; the rest are reached remotely via the resolver (and
        // a defineLazyService factory for an unmounted service never runs).
        for (const definition of services) {
            if (enabledServices !== undefined && !enabledServices.includes(definition.descriptor.typeName)) {
                continue;
            }
            definition.register(router, registerContext);
        }
        // Everything registered up to here came from user services;
        // services added below belong to protocols.
        userServiceCount = mountedServices.length;

        // Register protocols. On the first materialization each protocol is set
        // up right before its own registration, so it sees the application
        // services and files plus those of the protocols before it —
        // Healthcheck does not track itself, Reflection lists the protocols
        // registered earlier. The snapshots keep that view fixed even though
        // `registry` and `mountedServices` keep growing.
        const settingUp = !protocolsSetUp;
        for (const protocol of protocols) {
            if (settingUp) {
                const context: ProtocolContext = {
                    registry: Object.freeze([...registry]),
                    services: Object.freeze([...mountedServices]),
                };
                protocol.setup?.(context);
            }
            protocol.register(router);
        }
        protocolsSetUp = true;
    };

    // Collect HTTP handlers from protocols
    const httpHandlers = protocols.map((p) => p.httpHandler).filter((h) => h !== null && h !== undefined);

    // Create HTTP/2 server adapter. Unset admission options are left out of the
    // object entirely, so a server without them builds exactly the adapter it
    // built before these options existed. `!== undefined` (not truthiness) so
    // an invalid `readMaxBytes: 0` reaches Connect's range check and fails
    // loudly instead of silently meaning "no limit".
    const adapter = connectNodeAdapter({
        routes,
        // `finishStreamOnAbort` goes last, next to the handler: whether a
        // cancelled call unwinds the handler's generator through the failed
        // socket write depends on the runtime (a write to a closed stream can
        // still report success), while the call's signal always aborts.
        interceptors: [stripLocalTransportHeaderOnHttp, ...interceptors, finishStreamOnAbort],
        shutdownSignal,
        ...(jsonOptions ? { jsonOptions } : {}),
        ...(requestGate !== undefined ? { requestGate } : {}),
        ...(readMaxBytes !== undefined ? { readMaxBytes } : {}),
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

    // SECURITY: delete a forged `connectum-internal-transport` header before
    // the adapter sees the request. Connect runs `requestGate` (server-level
    // AND per-service) before any interceptor, on a copy of the headers the
    // adapter builds from `req.headers` — so the strip interceptor above comes
    // too late for gates. Node lowercases incoming header names, so one key
    // covers every casing. Legitimate in-process calls never reach this
    // handler and keep the marker.
    const handler = (req: NodeRequest, res: NodeResponse): void => {
        delete req.headers[LOCAL_TRANSPORT_HEADER];
        (adapter as (req: NodeRequest, res: NodeResponse) => void)(req, res);
    };

    // connectNodeAdapter invokes routes() synchronously, so both the full
    // registry and the user services are populated at this point.
    return {
        handler,
        registry,
        routes,
        registeredServiceTypeNames,
        userServices: mountedServices.slice(0, userServiceCount),
    };
}

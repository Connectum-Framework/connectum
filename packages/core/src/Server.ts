/**
 * Server implementation with explicit lifecycle
 *
 * Provides the new Server API (PRD v1.1) with explicit start/stop control.
 *
 * @module Server
 */

import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { DescFile, DescService } from "@bufbuild/protobuf";
import type { Client, ConnectRouter, HandlerContext, Interceptor, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { buildRoutes } from "./buildRoutes.ts";
import { CatalogDispatcher, type CatalogDispatchHost } from "./catalogDispatcher.ts";
import { CatalogConfigError } from "./catalogErrors.ts";
import type { Context } from "./context.ts";
import type { ServiceDefinition } from "./defineService.ts";
import { performGracefulShutdown } from "./gracefulShutdown.ts";
import { createLocalTransport } from "./localTransport.ts";
import { ShutdownManager } from "./ShutdownManager.ts";
import { TransportManager } from "./TransportManager.ts";
import { resolveEffectiveTransport, validateTransport } from "./TransportValidation.ts";
import type { CreateServerOptions, EventBusLike, ProtocolRegistration, Server, ServerClientOptions, ShutdownHook, TransportServer } from "./types.ts";
import { ServerState } from "./types.ts";

/**
 * Server implementation class
 *
 * Internal implementation of the Server interface.
 * Use createServer() factory function to create instances.
 */
class ServerImpl extends EventEmitter implements Server {
    // =========================================================================
    // Private state
    // =========================================================================

    private _state: ServerState = ServerState.CREATED;
    private readonly _options: CreateServerOptions;
    private readonly _routes: ServiceDefinition[];
    private readonly _protocols: ProtocolRegistration[];
    private readonly _interceptors: Interceptor[];
    private readonly _outgoingInterceptors: Interceptor[];
    private readonly _registry: DescFile[] = [];
    private readonly _shutdownManager = new ShutdownManager();
    private readonly _abortController = new AbortController();
    private _signalHandlers: Map<NodeJS.Signals, () => void> = new Map();
    private _stopPromise: Promise<void> | null = null;
    private readonly _transport = new TransportManager();
    private readonly _eventBus: EventBusLike | null = null;

    /**
     * Memoized output of buildRoutes() — populated on first access (either via
     * server.start() or via the in-process transport accessor). Once built, the
     * registered services/interceptors/protocols become immutable.
     */
    private _builtRoutes: ReturnType<typeof buildRoutes> | null = null;

    /** Memoized in-process transport (lazy, created on first localClient call) */
    private _localTransport: Transport | null = null;

    /**
     * Memoized in-process transport for `ctx.call` local dispatch. Distinct from
     * {@link _localTransport} because it carries `outgoingInterceptors` on the
     * client side (lazy, created on first local `ctx.call`).
     */
    private _catalogLocalTransport: Transport | null = null;

    /** Resolver-supplied remote transports, cached per `(typeName, endpoint)` key. */
    private readonly _remoteTransports = new Map<string, Transport>();

    /** Per-server engine behind `ctx.call`; wraps handlers + routes catalog calls. */
    private readonly _dispatcher: CatalogDispatcher;

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(options: CreateServerOptions) {
        super();
        this._options = options;
        this._routes = [...options.services];
        this._protocols = [...(options.protocols ?? [])];
        this._interceptors = [...(options.interceptors ?? [])];
        this._outgoingInterceptors = [...(options.outgoingInterceptors ?? [])];
        this._eventBus = options.eventBus ?? null;

        // Engine behind ctx.call. The host closures read the live server state at
        // call time (routes are materialized by then), so there is no
        // construction-order coupling with route building.
        const host: CatalogDispatchHost = {
            catalog: options.catalog,
            propagateHeaders: options.propagateHeaders ?? [],
            isLocal: (typeName) => this._getRegisteredServiceTypeNames().has(typeName),
            getLocalTransport: () => this._getCatalogLocalTransport(),
            resolveRemoteTransport: (typeName, endpoint) => this._resolveRemoteTransport(typeName, endpoint),
        };
        this._dispatcher = new CatalogDispatcher(host);
    }

    // =========================================================================
    // State properties
    // =========================================================================

    get address(): AddressInfo | null {
        return this._transport.address;
    }

    get isRunning(): boolean {
        return this._state === ServerState.RUNNING;
    }

    get state(): ServerState {
        return this._state;
    }

    get transport(): TransportServer | null {
        return this._transport.server;
    }

    get routes(): ReadonlyArray<ServiceDefinition> {
        return this._routes;
    }

    get interceptors(): ReadonlyArray<Interceptor> {
        return this._interceptors;
    }

    get protocols(): ReadonlyArray<ProtocolRegistration> {
        return this._protocols;
    }

    get eventBus(): EventBusLike | null {
        return this._eventBus;
    }

    get shutdownSignal(): AbortSignal {
        return this._abortController.signal;
    }

    // =========================================================================
    // Shutdown hooks
    // =========================================================================

    onShutdown(handler: ShutdownHook): void;
    onShutdown(name: string, handler: ShutdownHook): void;
    onShutdown(name: string, dependencies: string[], handler: ShutdownHook): void;
    onShutdown(nameOrHandler: string | ShutdownHook, depsOrHandler?: string[] | ShutdownHook, handler?: ShutdownHook): void {
        if (this._state === ServerState.STOPPED) {
            throw new Error("Cannot add shutdown hook: server is already stopped");
        }
        // Delegate to ShutdownManager with the same overload signature
        if (typeof nameOrHandler === "function") {
            this._shutdownManager.addHook(nameOrHandler);
        } else if (typeof depsOrHandler === "function") {
            this._shutdownManager.addHook(nameOrHandler, depsOrHandler);
        } else {
            this._shutdownManager.addHook(nameOrHandler, depsOrHandler as string[], handler as ShutdownHook);
        }
    }

    // =========================================================================
    // Lifecycle methods
    // =========================================================================

    async start(): Promise<void> {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot start server: current state is "${this._state}", expected "${ServerState.CREATED}"`);
        }

        this._state = ServerState.STARTING;
        this.emit("start");

        try {
            // Shape check (always runs): enabledServices must be a subset of the
            // catalog. A typo here is a configuration mistake → CatalogConfigError.
            this._validateCatalogConfig();

            // Lazy-built path: routes may already have been materialized via
            // localClient()/client() before start(). _ensureRoutesBuilt()
            // memoizes the full BuildRoutesResult (including userRegistry and
            // jsonOptions) so transport validation below runs against the same
            // user-service slice regardless of when routes were built.
            const { handler, registry, userRegistry } = this._ensureRoutesBuilt();
            // Only push registry entries not already collected (lazy build may
            // have populated it before start()).
            if (this._registry.length === 0) {
                this._registry.push(...registry);
            }

            // Streaming kinds vs transport: USER bidi methods on a plaintext
            // HTTP/1.1 server hang silently at runtime — fail fast instead;
            // on a TLS server that also allows HTTP/1.1 the same hang is a
            // residual risk for HTTP/1.1-negotiating clients → one-time warn.
            // Protocol-contributed services (gRPC Reflection's
            // ServerReflectionInfo is bidi) are excluded: their transport
            // limitations are documented, not a user misconfiguration.
            // The thrown error and the 'error' event below carry the SAME
            // object; the framework itself prints nothing (no double reporting).
            const validationError = validateTransport({
                registry: userRegistry,
                // Boolean() mirrors TransportManager's truthy TLS check, so a
                // falsy-but-defined tls (e.g. null from untyped JS) is treated
                // as plaintext consistently with the actual transport selection.
                transport: resolveEffectiveTransport({ hasTls: Boolean(this._options.tls), allowHTTP1: this._options.allowHTTP1 }),
                mode: this._options.transportValidation ?? "error",
            });
            if (validationError) {
                throw validationError;
            }

            if (this._eventBus) {
                await this._eventBus.start({ signal: this._abortController.signal });
                this._shutdownManager.addHook("eventbus", async () => {
                    await this._eventBus?.stop();
                });
            }

            await this._transport.listen(handler, {
                port: this._options.port,
                host: this._options.host,
                tls: this._options.tls,
                allowHTTP1: this._options.allowHTTP1,
                handshakeTimeout: this._options.handshakeTimeout,
                http2Options: this._options.http2Options,
            });

            this._state = ServerState.RUNNING;
            this._setupAutoShutdown();
            this.emit("ready");
        } catch (error) {
            // Clean up event bus if it was started but transport failed
            if (this._eventBus) {
                await this._eventBus.stop().catch(() => {});
            }
            this._state = ServerState.STOPPED;
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    async stop(): Promise<void> {
        // Guard against concurrent stop() calls — return existing promise if shutdown is in progress
        if (this._state === ServerState.STOPPING && this._stopPromise) {
            return this._stopPromise;
        }

        if (this._state !== ServerState.RUNNING) {
            throw new Error(`Cannot stop server: current state is "${this._state}", expected "${ServerState.RUNNING}"`);
        }

        this._state = ServerState.STOPPING;

        // Phase 0: Notify listeners (e.g. healthcheck → NOT_SERVING)
        this.emit("stopping");

        // Phase 1: Signal shutdown to ConnectRPC handlers (streaming RPCs)
        this._abortController.abort();

        this._stopPromise = (async () => {
            try {
                this._removeAutoShutdown();

                // Phases 2-4 with timeout
                await performGracefulShutdown(this._transport, this._shutdownManager, {
                    timeout: this._options.shutdown?.timeout ?? 30_000,
                    forceCloseOnTimeout: this._options.shutdown?.forceCloseOnTimeout ?? true,
                });

                this._state = ServerState.STOPPED;
                this.emit("stop");
            } catch (error) {
                this._state = ServerState.STOPPED;
                this.emit("error", error instanceof Error ? error : new Error(String(error)));
                throw error;
            } finally {
                this._stopPromise = null;
            }
        })();

        return this._stopPromise;
    }

    // =========================================================================
    // Runtime operations
    // =========================================================================

    addService(service: ServiceDefinition): void {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot add service: server is already ${this._state}. Add services before calling start().`);
        }
        if (this._builtRoutes !== null) {
            throw new Error("Cannot add service: routes have already been materialized (e.g. via server.localClient()). Add services before any local-transport access.");
        }
        this._routes.push(service);
    }

    addInterceptor(interceptor: Interceptor): void {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot add interceptor: server is already ${this._state}. Add interceptors before calling start().`);
        }
        if (this._builtRoutes !== null) {
            throw new Error("Cannot add interceptor: routes have already been materialized (e.g. via server.localClient()). Add interceptors before any local-transport access.");
        }
        this._interceptors.push(interceptor);
    }

    addProtocol(protocol: ProtocolRegistration): void {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot add protocol: server is already ${this._state}. Add protocols before calling start().`);
        }
        if (this._builtRoutes !== null) {
            throw new Error("Cannot add protocol: routes have already been materialized (e.g. via server.localClient()). Add protocols before any local-transport access.");
        }
        this._protocols.push(protocol);
    }

    // =========================================================================
    // In-process transport
    // =========================================================================

    /**
     * Return a fully-typed ConnectRPC client backed by an in-process transport.
     *
     * The transport dispatches calls directly to handlers registered on this
     * server's `ConnectRouter`, without opening any TCP socket. Safe to call
     * before `server.start()`.
     *
     * @internal Implementation detail: see `createLocalTransport`.
     */
    localClient<T extends DescService>(service: T): Client<T> {
        let transport = this._localTransport;
        if (transport === null) {
            transport = createLocalTransport(this);
            this._localTransport = transport;
        }
        return createClient(service, transport);
    }

    /**
     * Synchronous lookup: is the given proto service descriptor served locally
     * by this `Server`? Triggers route materialization on first call.
     *
     * @example
     * ```typescript
     * if (server.hasService(GreeterService)) { /* local *\/ }
     * ```
     */
    hasService(desc: DescService): boolean {
        const names = this._getRegisteredServiceTypeNames();
        return names.has(desc.typeName);
    }

    /**
     * Unified client factory — routes to the in-process transport for locally
     * mounted services and to the configured `remoteResolver` for everything
     * else. The same call site works for monolith and split deployments.
     *
     * Eager checks (Q18): a non-local service with no `remoteResolver` is a
     * configuration mistake → `CatalogConfigError`; a resolver that returns
     * `null` is an operational miss → `ConnectError(Code.Unavailable)`.
     * `Code.Unimplemented` is reserved for a runtime `ctx.call` dispatch miss.
     *
     * @example
     * ```typescript
     * const inventory = server.client(InventoryService); // local or remote — same call
     * ```
     */
    client<T extends DescService>(service: T, options?: ServerClientOptions): Client<T> {
        if (this.hasService(service)) {
            return this.localClient(service);
        }
        if (!this._options.remoteResolver) {
            throw new CatalogConfigError(
                `Cannot create a client for "${service.typeName}": it is not mounted locally and no remoteResolver is configured. ` +
                    `Mount it locally (createServer({ services })) or configure createServer({ remoteResolver }).`,
            );
        }
        const transport = this._resolveRemoteTransport(service.typeName, options?.endpoint);
        if (!transport) {
            const at = options?.endpoint ? ` (endpoint "${options.endpoint}")` : "";
            throw new ConnectError(`No route for service "${service.typeName}"${at}: the resolver returned null.`, Code.Unavailable);
        }
        return createClient(service, transport);
    }

    /**
     * Resolve (and cache) the `Transport` for a remote service via the configured
     * `remoteResolver`. Cached per unique `(typeName, endpoint)` key so the
     * resolver runs at most once per route.
     *
     * @internal
     */
    private _resolveRemoteTransport(typeName: string, endpoint?: string): Transport | null {
        const key = `${typeName} ${endpoint ?? ""}`;
        const cached = this._remoteTransports.get(key);
        if (cached) return cached;
        const ctx = endpoint !== undefined ? { typeName, endpoint } : { typeName };
        const transport = this._options.remoteResolver?.(ctx) ?? null;
        if (transport) this._remoteTransports.set(key, transport);
        return transport;
    }

    /**
     * In-process transport used by `ctx.call` to dispatch to locally-mounted
     * services. Carries `outgoingInterceptors` on the client side (so the OTel
     * client interceptor and any user-supplied outgoing interceptor wrap the
     * call), distinguishing it from {@link localClient}'s plain transport.
     * Lazily built and memoized.
     *
     * @internal
     */
    private _getCatalogLocalTransport(): Transport {
        if (this._catalogLocalTransport === null) {
            this._catalogLocalTransport = createLocalTransport(this, { interceptors: this._outgoingInterceptors });
        }
        return this._catalogLocalTransport;
    }

    /**
     * Validate the catalog configuration at startup. Currently the always-on
     * shape check: every `enabledServices` entry must be a known catalog key
     * (when a `catalog` is configured). A mismatch is a programmer error
     * → `CatalogConfigError`.
     *
     * @internal
     */
    private _validateCatalogConfig(): void {
        const { catalog, enabledServices } = this._options;
        if (!catalog || !enabledServices) return;
        const missing = enabledServices.filter((name) => !Object.hasOwn(catalog, name));
        if (missing.length > 0) {
            const known = Object.keys(catalog);
            throw new CatalogConfigError(
                `enabledServices lists ${missing.length} typeName(s) absent from the catalog: ${missing.join(", ")}. ` +
                    `Known catalog services: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
            );
        }
    }

    /**
     * Materialize the ConnectRouter routes callback. Idempotent: subsequent
     * calls return the same memoized result, and further mutations to
     * services/interceptors/protocols are rejected.
     *
     * @internal Used by Server.start() and createLocalTransport().
     */
    _ensureRoutesBuilt(): ReturnType<typeof buildRoutes> {
        if (this._builtRoutes === null) {
            this._builtRoutes = buildRoutes({
                services: this._routes,
                protocols: this._protocols,
                interceptors: this._interceptors,
                shutdownSignal: this._abortController.signal,
                registerContext: this._dispatcher,
                // Thread server-wide jsonOptions through the lazy path too, so
                // in-process and HTTP transports share identical JSON
                // serialization (otherwise jsonOptions would be silently
                // dropped on the lazy-built route materialization).
                ...(this._options.jsonOptions ? { jsonOptions: this._options.jsonOptions } : {}),
                // Mount only the locally-enabled services; the rest are remote.
                ...(this._options.enabledServices ? { enabledServices: this._options.enabledServices } : {}),
            });
            // Lazy-built path: populate registry now so server.routes consumers
            // see the same DescFile[] before start().
            if (this._registry.length === 0) {
                this._registry.push(...this._builtRoutes.registry);
            }
        }
        return this._builtRoutes;
    }

    /**
     * Expose the underlying `(router) => void` route-registration callback
     * for in-process transport construction.
     *
     * @internal
     */
    _getRoutesCallback(): (router: ConnectRouter) => void {
        return this._ensureRoutesBuilt().routes;
    }

    /**
     * Expose the registered server-side interceptors as a fresh array.
     *
     * @internal
     */
    _getServerInterceptors(): Interceptor[] {
        return [...this._interceptors];
    }

    /**
     * Expose the set of `DescService.typeName` strings actually registered via
     * `router.service()` in this server. Drives auto-routing in
     * {@link ServerImpl.client}.
     *
     * @internal
     */
    _getRegisteredServiceTypeNames(): ReadonlySet<string> {
        return this._ensureRoutesBuilt().registeredServiceTypeNames;
    }

    /**
     * Build a catalog {@link Context} over a (typically synthetic)
     * `HandlerContext`, driving the same dispatcher as a live request. Used by
     * `@connectum/testing`'s `createMockContext` to test handler `ctx.call` /
     * `ctx.stream` logic in isolation.
     *
     * @internal
     */
    _makeCatalogContext(hctx: HandlerContext): Context {
        return this._dispatcher.makeContext(hctx);
    }

    // =========================================================================
    // Private methods
    // =========================================================================

    private _setupAutoShutdown(): void {
        const { shutdown = {} } = this._options;

        if (!shutdown.autoShutdown) {
            return;
        }

        const signals = shutdown.signals ?? ["SIGTERM", "SIGINT"];

        for (const signal of signals) {
            const handler = () => {
                console.info(`Received ${signal}, initiating graceful shutdown...`);
                this.stop().catch((err) => {
                    this.emit("error", err instanceof Error ? err : new Error(String(err)));
                });
            };

            this._signalHandlers.set(signal, handler);
            process.on(signal, handler);
        }
    }

    private _removeAutoShutdown(): void {
        for (const [signal, handler] of this._signalHandlers) {
            process.removeListener(signal, handler);
        }
        this._signalHandlers.clear();
    }
}

/**
 * Create a new server instance
 *
 * Returns an unstarted server. Call server.start() to begin accepting connections.
 *
 * @param options - Server configuration options
 * @returns Unstarted server instance
 *
 * @example
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
 * import { Reflection } from '@connectum/reflection';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
 *   shutdown: { autoShutdown: true },
 * });
 *
 * server.on('ready', () => {
 *   healthcheckManager.update(ServingStatus.SERVING);
 * });
 *
 * await server.start();
 * ```
 */
export function createServer(options: CreateServerOptions): Server {
    return new ServerImpl(options);
}

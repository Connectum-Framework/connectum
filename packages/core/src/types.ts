/**
 * Public API types for Server
 *
 * @module types
 */

import type { EventEmitter } from "node:events";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import type { Http2SecureServer, Http2Server, Http2ServerRequest, Http2ServerResponse, SecureServerOptions } from "node:http2";
import type { AddressInfo } from "node:net";
import type { DescFile, DescService, JsonReadOptions, JsonWriteOptions } from "@bufbuild/protobuf";
import type { Client, ConnectRouter, Interceptor } from "@connectrpc/connect";
import type { ServiceDefinition } from "./defineService.ts";
import type { RemoteResolver } from "./remoteResolver.ts";
import type { ServiceCatalog } from "./serviceCatalog.ts";

// =============================================================================
// TRANSPORT UNION TYPES
// =============================================================================

/** Incoming request — HTTP/1.1 or HTTP/2 */
export type NodeRequest = IncomingMessage | Http2ServerRequest;

/** Server response — HTTP/1.1 or HTTP/2 */
export type NodeResponse = ServerResponse | Http2ServerResponse;

/** Underlying transport server — HTTP/1.1, HTTP/2 plaintext, or HTTP/2 TLS */
export type TransportServer = HttpServer | Http2Server | Http2SecureServer;

// Service registration is expressed with `ServiceDefinition` (see
// ./defineService.ts) — a `{ descriptor, register }` pair produced by
// `defineService` / `defineLazyService`. The legacy `ServiceRoute =
// (router) => void` form was removed in favour of it.

/**
 * Shutdown hook function type
 *
 * A function called during graceful shutdown. May be synchronous or async.
 */
export type ShutdownHook = () => void | Promise<void>;

// =============================================================================
// PROTOCOL REGISTRATION API
// =============================================================================

/**
 * Context provided to protocol registration functions
 *
 * Contains information about registered services that protocols
 * may need (e.g., reflection needs DescFile[], healthcheck needs service names).
 */
export interface ProtocolContext {
    /** Registered service file descriptors */
    readonly registry: ReadonlyArray<DescFile>;
}

/**
 * HTTP handler for protocol-specific endpoints
 *
 * @returns true if the request was handled, false otherwise
 */
export type HttpHandler = (req: NodeRequest, res: NodeResponse) => boolean;

/**
 * Protocol registration interface
 *
 * Protocols (healthcheck, reflection, custom) implement this interface
 * to register themselves on the server's ConnectRouter.
 *
 * @example
 * ```typescript
 * const myProtocol: ProtocolRegistration = {
 *   name: "my-protocol",
 *   register(router, context) {
 *     router.service(MyService, myImpl);
 *   },
 * };
 *
 * const server = createServer({
 *   services: [routes],
 *   protocols: [myProtocol],
 * });
 * ```
 */
export interface ProtocolRegistration {
    /** Protocol name for identification (e.g., "healthcheck", "reflection") */
    readonly name: string;

    /** Register protocol services on the router */
    register(router: ConnectRouter, context: ProtocolContext): void;

    /** Optional HTTP handler for fallback routing (e.g., /healthz endpoint) */
    httpHandler?: HttpHandler;
}

/**
 * TLS configuration options
 */
export interface TLSOptions {
    /**
     * Path to TLS key file
     */
    keyPath?: string;

    /**
     * Path to TLS certificate file
     */
    certPath?: string;

    /**
     * TLS directory path (alternative to keyPath/certPath)
     * Will look for server.key and server.crt in this directory
     */
    dirPath?: string;
}

// =============================================================================
// EVENT BUS INTEGRATION
// =============================================================================

/**
 * Minimal interface for event bus lifecycle integration with the server.
 *
 * Packages implementing event bus adapters (e.g., @connectum/events)
 * must satisfy this interface to be used with `createServer({ eventBus })`.
 */
export interface EventBusLike {
    /**
     * Start the event bus (connect to broker, set up subscriptions).
     *
     * @param options - Optional start parameters
     * @param options.signal - Abort signal from server for graceful shutdown
     */
    start(options?: { signal?: AbortSignal }): Promise<void>;
    /** Stop the event bus (drain subscriptions, disconnect) */
    stop(): Promise<void>;
}

// =============================================================================
// SERVER API
// =============================================================================

/**
 * Server state constants
 *
 * Note: Using const object instead of enum for native TypeScript compatibility
 */
export const ServerState = {
    /** Server created but not started */
    CREATED: "created",
    /** Server is starting */
    STARTING: "starting",
    /** Server is running and accepting connections */
    RUNNING: "running",
    /** Server is stopping */
    STOPPING: "stopping",
    /** Server has stopped */
    STOPPED: "stopped",
} as const;

export type ServerState = (typeof ServerState)[keyof typeof ServerState];

/**
 * Lifecycle event names
 */
export const LifecycleEvent = {
    /** Emitted when server starts (before ready) */
    START: "start",
    /** Emitted when server is ready to accept connections */
    READY: "ready",
    /** Emitted when server begins graceful shutdown */
    STOPPING: "stopping",
    /** Emitted when server stops */
    STOP: "stop",
    /** Emitted on error */
    ERROR: "error",
} as const;

export type LifecycleEvent = (typeof LifecycleEvent)[keyof typeof LifecycleEvent];

/**
 * Graceful shutdown options
 */
export interface ShutdownOptions {
    /**
     * Timeout in milliseconds for graceful shutdown
     * @default 30000
     */
    timeout?: number;

    /**
     * Signals to listen for graceful shutdown
     * @default ["SIGTERM", "SIGINT"]
     */
    signals?: NodeJS.Signals[];

    /**
     * Enable automatic graceful shutdown on signals
     * @default false
     */
    autoShutdown?: boolean;

    /**
     * Force close all HTTP/2 sessions when shutdown timeout is exceeded.
     * When true, sessions are destroyed after timeout. When false, server
     * waits indefinitely for in-flight requests to complete.
     * @default true
     */
    forceCloseOnTimeout?: boolean;
}

/**
 * Server configuration options for createServer()
 */
export interface CreateServerOptions {
    /**
     * Service routes to register
     */
    services: readonly ServiceDefinition[];

    /**
     * Server port
     * @default 5000
     */
    port?: number;

    /**
     * Server host to bind
     * @default "0.0.0.0"
     */
    host?: string;

    /**
     * TLS configuration
     */
    tls?: TLSOptions;

    /**
     * Protocol registrations (healthcheck, reflection, custom)
     *
     * @example
     * ```typescript
     * import { Healthcheck } from '@connectum/healthcheck';
     * import { Reflection } from '@connectum/reflection';
     *
     * const server = createServer({
     *   services: [routes],
     *   protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
     * });
     * ```
     */
    protocols?: ProtocolRegistration[];

    /**
     * Graceful shutdown configuration
     */
    shutdown?: ShutdownOptions;

    /**
     * ConnectRPC interceptors.
     * When omitted or `[]`, no interceptors are applied.
     * Use `createDefaultInterceptors()` from `@connectum/interceptors` to get the default chain.
     */
    interceptors?: Interceptor[];

    /**
     * Event bus instance for pub/sub messaging.
     *
     * The event bus is started during `server.start()` (after route building,
     * before transport listen) and stopped during graceful shutdown.
     *
     * @example
     * ```typescript
     * import { createEventBus } from '@connectum/events';
     * import { NatsAdapter } from '@connectum/events-nats';
     *
     * const eventBus = createEventBus({
     *   adapter: NatsAdapter({ servers: ['nats://localhost:4222'] }),
     *   router: eventRouter,
     * });
     *
     * const server = createServer({
     *   services: [routes],
     *   eventBus,
     * });
     * ```
     */
    eventBus?: EventBusLike;

    /**
     * Allow HTTP/1.1 connections.
     *
     * With TLS: enables ALPN negotiation (both HTTP/1.1 and HTTP/2).
     * Without TLS: creates HTTP/1.1 server (http.createServer).
     * Set to false without TLS for h2c-only (http2.createServer).
     *
     * @default true
     */
    allowHTTP1?: boolean;

    /**
     * Startup validation of streaming method kinds vs the effective transport.
     *
     * Bidi-streaming methods require HTTP/2 (Connect protocol: "Bidirectional
     * streaming requires HTTP/2, but the other RPC types also support
     * HTTP/1.1"). On a plaintext HTTP/1.1 server (no TLS + `allowHTTP1: true`,
     * the default) they fail silently at runtime — the first send hangs
     * forever. With `"error"` (default) `start()` rejects with a
     * `TransportValidationError` (code `CONNECTUM_UNSUPPORTED_STREAMING_TRANSPORT`)
     * naming the affected methods and both fixes; `"warn"` logs once and
     * starts anyway; `"off"` skips the check.
     *
     * On a TLS server that also allows HTTP/1.1 (`allowHTTP1: true`), bidi
     * works for HTTP/2 clients but a client negotiating HTTP/1.1 over TLS
     * hits the same hang — this residual risk is always a one-time warning
     * (never a hard error), silenced only by `"off"`. Set `allowHTTP1: false`
     * to remove the risk (the server refuses HTTP/1.1 at ALPN).
     *
     * @default "error"
     */
    transportValidation?: "error" | "warn" | "off";

    /**
     * Handshake timeout in milliseconds
     * @default 30000
     */
    handshakeTimeout?: number;

    /**
     * Additional HTTP/2 server options
     */
    http2Options?: SecureServerOptions;

    /**
     * Connect JSON serialization options applied server-wide.
     *
     * Passed through to the underlying `connectNodeAdapter`, so it affects every
     * registered service and protocol (e.g. healthcheck, reflection). The most
     * common use is `alwaysEmitImplicit: true`, which includes fields with
     * implicit presence (proto3 scalar `0`, empty string/list, enum default) in
     * JSON responses instead of omitting them.
     *
     * For per-service control, pass the same option as the third argument of
     * `router.service()` inside a {@link ServiceDefinition}'s `register` closure
     * instead.
     *
     * Note: the relevant `JsonWriteOptions` field in `@bufbuild/protobuf` v2 is
     * `alwaysEmitImplicit` (named `emitDefaultValues` in v1).
     *
     * @example
     * ```typescript
     * const server = createServer({
     *   services: [routes],
     *   jsonOptions: { alwaysEmitImplicit: true },
     * });
     * ```
     */
    jsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>;

    // ── Service catalog (optional; a plain monolith needs none of these) ──

    /**
     * The full set of services known to the system, `typeName → DescService`
     * (typically the generated `serviceCatalog`). Drives startup validation and
     * remote routing. Optional — a process that hosts everything locally and
     * makes no cross-service calls needs no catalog.
     */
    catalog?: ServiceCatalog;

    /**
     * Proto `typeName`s to mount **locally** from `services`. A service in
     * `services` whose `typeName` is not listed is treated as remote (resolved
     * via {@link CreateServerOptions.remoteResolver}). `undefined` mounts every
     * provided service locally.
     */
    enabledServices?: readonly string[];

    /**
     * Resolves a service that is not mounted locally to a `Transport`. Consulted
     * by `server.client()` (and `ctx.call`) for remote services. Synchronous and
     * must not perform network I/O — see {@link RemoteResolver}.
     */
    remoteResolver?: RemoteResolver;

    /**
     * Client-side interceptors applied to every outgoing `server.client()` /
     * `ctx.call` call (cross-cutting concerns like auth or logging), so call
     * sites stay free of boilerplate.
     */
    outgoingInterceptors?: readonly Interceptor[];

    /**
     * Inbound header names to copy onto every outgoing `ctx.call` / `ctx.stream`.
     * Empty by default — no header is propagated implicitly. Explicit
     * `CallOptions.headers` always win over a propagated value.
     *
     * Use {@link defaultPropagateHeaders} (W3C trace-context headers) as a base
     * and add your own, e.g. `[...defaultPropagateHeaders, "x-tenant-id"]`.
     */
    propagateHeaders?: readonly string[];
}

/**
 * Server interface with explicit lifecycle control
 *
 * @example
 * ```typescript
 * import { createServer } from '@connectum/core';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   port: 5000
 * });
 *
 * server.on('ready', () => console.log('Server ready!'));
 * server.on('error', (err) => console.error('Error:', err));
 *
 * await server.start();
 *
 * // Later
 * await server.stop();
 * ```
 */
export interface Server extends EventEmitter {
    // ==========================================================================
    // Lifecycle - explicit control
    // ==========================================================================

    /**
     * Start the server
     *
     * @throws Error if server is not in CREATED state
     */
    start(): Promise<void>;

    /**
     * Stop the server gracefully
     *
     * @throws Error if server is not in RUNNING state
     */
    stop(): Promise<void>;

    // ==========================================================================
    // State
    // ==========================================================================

    /**
     * Current server address
     *
     * Returns null until server is started
     */
    readonly address: AddressInfo | null;

    /**
     * Whether server is currently running
     */
    readonly isRunning: boolean;

    /**
     * Current server state
     */
    readonly state: ServerState;

    // ==========================================================================
    // Lifecycle hooks (EventEmitter methods)
    // ==========================================================================

    /**
     * Register listener for lifecycle events
     */
    on(event: "start", listener: () => void): this;
    on(event: "ready", listener: () => void): this;
    on(event: "stopping", listener: () => void): this;
    on(event: "stop", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;

    /**
     * Register one-time listener for lifecycle events
     */
    once(event: "start", listener: () => void): this;
    once(event: "ready", listener: () => void): this;
    once(event: "stopping", listener: () => void): this;
    once(event: "stop", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;

    /**
     * Remove listener for lifecycle events
     */
    off(event: "start", listener: () => void): this;
    off(event: "ready", listener: () => void): this;
    off(event: "stopping", listener: () => void): this;
    off(event: "stop", listener: () => void): this;
    off(event: "error", listener: (error: Error) => void): this;

    // ==========================================================================
    // Runtime operations
    // ==========================================================================

    /**
     * Add a service route at runtime
     *
     * @throws Error if server is already running
     */
    addService(service: ServiceDefinition): void;

    /**
     * Add an interceptor at runtime
     *
     * @throws Error if server is already running
     */
    addInterceptor(interceptor: Interceptor): void;

    /**
     * Add a protocol at runtime
     *
     * @throws Error if server is already running
     */
    addProtocol(protocol: ProtocolRegistration): void;

    // ==========================================================================
    // Shutdown hooks
    // ==========================================================================

    /**
     * Register an anonymous shutdown hook
     *
     * @param handler - Shutdown hook function
     * @throws Error if server is already stopped
     */
    onShutdown(handler: ShutdownHook): void;

    /**
     * Register a named shutdown hook
     *
     * @param name - Module name for dependency resolution
     * @param handler - Shutdown hook function
     * @throws Error if server is already stopped
     */
    onShutdown(name: string, handler: ShutdownHook): void;

    /**
     * Register a named shutdown hook with dependencies
     *
     * Dependencies are executed before this hook during shutdown.
     *
     * @param name - Module name for dependency resolution
     * @param dependencies - Module names that must shut down first
     * @param handler - Shutdown hook function
     * @throws Error if server is already stopped
     */
    onShutdown(name: string, dependencies: string[], handler: ShutdownHook): void;

    /**
     * Abort signal that is aborted when server begins shutdown.
     *
     * Use this to signal streaming RPCs and long-running operations
     * that the server is shutting down.
     */
    readonly shutdownSignal: AbortSignal;

    // ==========================================================================
    // Access to internals
    // ==========================================================================

    /**
     * Underlying transport server
     *
     * Returns null until server is started
     */
    readonly transport: TransportServer | null;

    /**
     * Registered service routes
     */
    readonly routes: ReadonlyArray<ServiceDefinition>;

    /**
     * Registered interceptors
     */
    readonly interceptors: ReadonlyArray<Interceptor>;

    /**
     * Registered protocols
     */
    readonly protocols: ReadonlyArray<ProtocolRegistration>;

    /**
     * Event bus instance, if configured
     *
     * Returns null if no event bus was provided to createServer().
     */
    readonly eventBus: EventBusLike | null;

    // ==========================================================================
    // In-process transport
    // ==========================================================================

    /**
     * Create a fully-typed ConnectRPC client that dispatches calls directly
     * to handlers registered on this server, without opening any TCP socket.
     *
     * Safe to call before `server.start()` — the routes are materialized
     * lazily on first access. Once materialized, `addService` / `addInterceptor`
     * / `addProtocol` will throw.
     *
     * @example
     * ```typescript
     * import { GreeterService } from './gen/greeter_pb.js';
     *
     * const server = createServer({ services: [routes] });
     * const client = server.localClient(GreeterService);
     * const response = await client.sayHello({ name: 'world' });
     * ```
     */
    localClient<T extends DescService>(service: T): Client<T>;

    /**
     * Synchronous registry lookup: returns whether the given proto service
     * descriptor is served locally by this `Server`. Triggers route
     * materialization on first call.
     *
     * Source of truth is the same `ConnectRouter.service(desc, impl)` chain
     * used to build the HTTP handler — no separate registration step.
     *
     * @example
     * ```typescript
     * if (server.hasService(GreeterService)) {
     *   // routed in-process
     * }
     * ```
     */
    hasService(desc: DescService): boolean;

    /**
     * Unified client factory: auto-routes to the in-process transport if the
     * service is registered on this `Server`, otherwise to the transport
     * supplied by the configured `remoteResolver` (e.g. a
     * `createGrpcTransport({ baseUrl })` to a remote peer). An optional
     * `options.endpoint` hint is forwarded to the resolver.
     *
     * Fail-fast (split error model): a non-local service with no `remoteResolver`
     * configured is a configuration mistake → throws {@link CatalogConfigError}
     * at the `server.client(...)` call. A resolver that returns `null` is an
     * operational miss → `ConnectError(Code.Unavailable)`.
     *
     * Enables polyglot deployments where the same call site (`server.client(S)`)
     * routes locally in a modular monolith and remotely when the service is
     * split into a separate process — without code changes.
     *
     * @example
     * ```typescript
     * // Configure the resolver once; the same call works whether GreeterService
     * // is co-located or remote:
     * const server = createServer({ services: [...], remoteResolver });
     * const client = server.client(GreeterService);
     * await client.sayHello({ name: 'world' });
     * ```
     */
    client<T extends DescService>(service: T, options?: ServerClientOptions): Client<T>;
}

/**
 * Options for {@link Server.client}.
 */
export interface ServerClientOptions {
    /**
     * Opaque endpoint hint forwarded to the configured `remoteResolver` when the
     * requested service is not mounted locally (polymorphic deployments — one
     * proto served at several endpoints). Ignored for locally-mounted services.
     */
    endpoint?: string;
}

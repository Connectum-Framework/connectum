/**
 * Public API types for Server
 *
 * @module types
 */

import type { EventEmitter } from "node:events";
import type { Http2SecureServer, Http2Server, Http2ServerRequest, Http2ServerResponse, SecureServerOptions } from "node:http2";
import type { AddressInfo } from "node:net";
import type { DescFile } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";

/**
 * Service route function
 *
 * Function that registers services on the ConnectRouter.
 */
export type ServiceRoute = (router: ConnectRouter) => void;

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
export type HttpHandler = (req: Http2ServerRequest, res: Http2ServerResponse) => boolean;

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
    services: ServiceRoute[];

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
     * Allow HTTP/1.1 connections
     * @default true
     */
    allowHTTP1?: boolean;

    /**
     * Handshake timeout in milliseconds
     * @default 30000
     */
    handshakeTimeout?: number;

    /**
     * Additional HTTP/2 server options
     */
    http2Options?: SecureServerOptions;
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
    addService(service: ServiceRoute): void;

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
     * Underlying HTTP/2 transport
     *
     * Returns null until server is started
     */
    readonly transport: Http2SecureServer | Http2Server | null;

    /**
     * Registered service routes
     */
    readonly routes: ReadonlyArray<ServiceRoute>;

    /**
     * Registered interceptors
     */
    readonly interceptors: ReadonlyArray<Interceptor>;

    /**
     * Registered protocols
     */
    readonly protocols: ReadonlyArray<ProtocolRegistration>;
}

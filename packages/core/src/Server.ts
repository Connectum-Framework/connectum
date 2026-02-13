/**
 * Server implementation with explicit lifecycle
 *
 * Provides the new Server API (PRD v1.1) with explicit start/stop control.
 *
 * @module Server
 */

import { EventEmitter } from "node:events";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import type { DescFile } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { buildRoutes } from "./buildRoutes.ts";
import { performGracefulShutdown } from "./gracefulShutdown.ts";
import { ShutdownManager } from "./ShutdownManager.ts";
import { TransportManager } from "./TransportManager.ts";
import type { CreateServerOptions, ProtocolRegistration, Server, ServiceRoute, ShutdownHook } from "./types.ts";
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
    private readonly _routes: ServiceRoute[];
    private readonly _protocols: ProtocolRegistration[];
    private readonly _interceptors: Interceptor[];
    private readonly _registry: DescFile[] = [];
    private readonly _shutdownManager = new ShutdownManager();
    private readonly _abortController = new AbortController();
    private _signalHandlers: Map<NodeJS.Signals, () => void> = new Map();
    private _stopPromise: Promise<void> | null = null;
    private readonly _transport = new TransportManager();

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(options: CreateServerOptions) {
        super();
        this._options = options;
        this._routes = [...options.services];
        this._protocols = [...(options.protocols ?? [])];
        this._interceptors = [...(options.interceptors ?? [])];
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

    get transport(): Http2SecureServer | Http2Server | null {
        return this._transport.server;
    }

    get routes(): ReadonlyArray<ServiceRoute> {
        return this._routes;
    }

    get interceptors(): ReadonlyArray<Interceptor> {
        return this._interceptors;
    }

    get protocols(): ReadonlyArray<ProtocolRegistration> {
        return this._protocols;
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
            const { handler, registry } = buildRoutes({
                services: this._routes,
                protocols: this._protocols,
                interceptors: this._interceptors,
                shutdownSignal: this._abortController.signal,
            });
            this._registry.push(...registry);

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

    addService(service: ServiceRoute): void {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot add service: server is already ${this._state}. Add services before calling start().`);
        }
        this._routes.push(service);
    }

    addInterceptor(interceptor: Interceptor): void {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot add interceptor: server is already ${this._state}. Add interceptors before calling start().`);
        }
        this._interceptors.push(interceptor);
    }

    addProtocol(protocol: ProtocolRegistration): void {
        if (this._state !== ServerState.CREATED) {
            throw new Error(`Cannot add protocol: server is already ${this._state}. Add protocols before calling start().`);
        }
        this._protocols.push(protocol);
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

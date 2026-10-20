/**
 * Server lifecycle integration tests
 *
 * Tests the full server lifecycle including eventBus integration,
 * protocol registration, startup failure cleanup, and event ordering.
 */

import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { ServiceDefinition } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { EventBusLike, ProtocolContext, ProtocolRegistration, Server } from "../../src/types.ts";
import { ServerState } from "../../src/types.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a no-op service definition for testing.
 *
 * Lifecycle tests never invoke an RPC, so the definition registers NOTHING
 * (mirrors the previous `(router) => {}` no-op route). The descriptor is
 * required by `ServiceDefinition` but unused: `register` is a no-op, so
 * `EchoService` is never mounted.
 */
const createMockService = (): ServiceDefinition => {
    return {
        descriptor: EchoService,
        register: () => {
            // no-op — sufficient for lifecycle tests
        },
    };
};

/** Create a mock EventBusLike with tracked calls */
function createMockEventBus(): EventBusLike & {
    startCalls: Array<{ signal?: AbortSignal }>;
    stopCalls: number;
    startFn: ReturnType<typeof mock.fn>;
    stopFn: ReturnType<typeof mock.fn>;
} {
    const startCalls: Array<{ signal?: AbortSignal }> = [];
    const startFn = mock.fn(async (options?: { signal?: AbortSignal }) => {
        if (options?.signal) {
            startCalls.push({ signal: options.signal });
        } else {
            startCalls.push({});
        }
    });
    const stopFn = mock.fn(async () => {});

    return {
        start: startFn,
        stop: stopFn,
        startCalls,
        stopCalls: 0,
        startFn,
        stopFn,
    };
}

/** Create a mock protocol with tracked setup and register calls */
function createMockProtocol(name: string): ProtocolRegistration & {
    setupCalls: ProtocolContext[];
    registerCalls: Array<{ router: ConnectRouter }>;
} {
    const setupCalls: ProtocolContext[] = [];
    const registerCalls: Array<{ router: ConnectRouter }> = [];

    return {
        name,
        setup(context: ProtocolContext) {
            setupCalls.push(context);
        },
        register(router: ConnectRouter) {
            registerCalls.push({ router });
        },
        setupCalls,
        registerCalls,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe("Server lifecycle integration", () => {
    let servers: Server[] = [];

    afterEach(async () => {
        for (const server of servers) {
            try {
                if (server.isRunning) {
                    await server.stop();
                }
            } catch {
                // Ignore errors during cleanup
            }
        }
        servers = [];
    });

    // =========================================================================
    // 1. Full server lifecycle with eventBus mock
    // =========================================================================

    describe("full lifecycle with eventBus", () => {
        it("should call eventBus.start() with abort signal during server start", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();

            const server = createServer({
                services: [service],
                port: 0,
                eventBus,
            });
            servers.push(server);

            await server.start();

            assert.strictEqual(eventBus.startFn.mock.calls.length, 1);
            const callArgs = eventBus.startCalls[0];
            assert.ok(callArgs, "start() should have been called with arguments");
            assert.ok(
                callArgs.signal instanceof AbortSignal,
                "eventBus.start() should receive an AbortSignal",
            );
            assert.strictEqual(
                callArgs.signal?.aborted,
                false,
                "signal should not be aborted while server is running",
            );
            // It is the server's own shutdown signal, not some unrelated one:
            // only then does stop() cancel the bus's work.
            assert.strictEqual(callArgs.signal, server.shutdownSignal);
            await server.stop();
            assert.strictEqual(callArgs.signal?.aborted, true, "stop() must abort the signal the event bus was started with");
        });

        it("should stop eventBus during server shutdown via shutdown hook", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();

            const server = createServer({
                services: [service],
                port: 0,
                eventBus,
            });
            servers.push(server);

            await server.start();
            assert.strictEqual(eventBus.stopFn.mock.calls.length, 0);

            await server.stop();
            assert.strictEqual(
                eventBus.stopFn.mock.calls.length,
                1,
                "eventBus.stop() should be called during server shutdown",
            );
        });

        // Graceful-shutdown guide, "EventBus": the bus is stopped by a shutdown hook named
        // `eventbus`, which is step 6 — after the abort signal and the transport close.
        it("should stop the event bus after the shutdown signal is aborted and the transport is closed", async () => {
            let atBusStop: { aborted: boolean; listening: boolean | undefined } | undefined;
            const eventBus = createMockEventBus();
            const server = createServer({ services: [createMockService()], port: 0, eventBus });
            servers.push(server);
            eventBus.stop = async () => {
                // The first call is the one that matters: a bus stopped earlier must not be hidden by a later call.
                atBusStop ??= { aborted: server.shutdownSignal.aborted, listening: server.transport?.listening };
            };

            await server.start();
            await server.stop();

            assert.deepStrictEqual(atBusStop, { aborted: true, listening: false });
        });

        it("should expose the event bus shutdown hook under the name `eventbus`, so that a hook can depend on it", async () => {
            const order: string[] = [];
            const eventBus = createMockEventBus();
            eventBus.stop = async () => {
                await setImmediate();
                order.push("bus-stopped");
            };
            const server = createServer({ services: [createMockService()], port: 0, eventBus });
            servers.push(server);
            // Registered first, so only the dependency edge can put it after the bus.
            server.onShutdown("after-bus", ["eventbus"], () => {
                order.push("after-bus");
            });

            await server.start();
            await server.stop();

            assert.deepStrictEqual(order, ["bus-stopped", "after-bus"]);
        });

        it("should fire events in correct order: start -> ready -> stopping -> stop", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();
            const order: string[] = [];

            const server = createServer({
                services: [service],
                port: 0,
                eventBus,
            });
            servers.push(server);

            server.on("start", () => order.push("start"));
            server.on("ready", () => order.push("ready"));
            server.on("stopping", () => order.push("stopping"));
            server.on("stop", () => order.push("stop"));

            await server.start();
            await server.stop();

            assert.deepStrictEqual(order, ["start", "ready", "stopping", "stop"]);
        });

        it("should expose eventBus on server instance", () => {
            const service = createMockService();
            const eventBus = createMockEventBus();

            const server = createServer({
                services: [service],
                eventBus,
            });
            servers.push(server);

            assert.strictEqual(server.eventBus, eventBus);
        });

        it("should return null eventBus when not configured", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });
            servers.push(server);

            assert.strictEqual(server.eventBus, null);
        });

        it("should abort the signal passed to eventBus during shutdown", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();

            const server = createServer({
                services: [service],
                port: 0,
                eventBus,
            });
            servers.push(server);

            await server.start();

            const signal = eventBus.startCalls[0]?.signal;
            assert.ok(signal, "signal should have been provided");
            assert.strictEqual(signal.aborted, false);

            await server.stop();
            assert.strictEqual(
                signal.aborted,
                true,
                "abort signal passed to eventBus should be aborted after stop",
            );
        });
    });

    // =========================================================================
    // 2. Server with multiple protocols
    // =========================================================================

    describe("server with multiple protocols", () => {
        it("should call register() on each protocol during start", async () => {
            const service = createMockService();
            const protocol1 = createMockProtocol("healthcheck");
            const protocol2 = createMockProtocol("reflection");
            const protocol3 = createMockProtocol("custom");

            const server = createServer({
                services: [service],
                port: 0,
                protocols: [protocol1, protocol2, protocol3],
            });
            servers.push(server);

            await server.start();

            assert.strictEqual(protocol1.registerCalls.length, 1, "protocol1.register() should be called once");
            assert.strictEqual(protocol2.registerCalls.length, 1, "protocol2.register() should be called once");
            assert.strictEqual(protocol3.registerCalls.length, 1, "protocol3.register() should be called once");
        });

        it("should pass ConnectRouter to each protocol register()", async () => {
            const service = createMockService();
            // The protocol mounts a service on the router it receives; the
            // router is the real one only if a client can then call it.
            const protocol: ProtocolRegistration = {
                name: "test-protocol",
                register(router: ConnectRouter) {
                    router.service(EchoService, {
                        echo: (req) => create(EchoResponseSchema, { message: `protocol:${req.message}`, timestamp: 0n }),
                    });
                },
            };

            const server = createServer({
                services: [service],
                port: 0,
                protocols: [protocol],
            });
            servers.push(server);

            await server.start();

            const client = createClient(EchoService, createConnectTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}`, httpVersion: "1.1" }));
            const response = await client.echo({ message: "ping" });
            assert.strictEqual(response.message, "protocol:ping");
        });

        it("should pass ProtocolContext with registry to each protocol", async () => {
            const service = createMockService();
            const protocol = createMockProtocol("test-protocol");

            const server = createServer({
                services: [service],
                port: 0,
                protocols: [protocol],
            });
            servers.push(server);

            await server.start();

            assert.strictEqual(protocol.setupCalls.length, 1);
            const context = protocol.setupCalls[0]!;
            assert.ok(context, "protocol should receive a context");
            assert.ok(
                Array.isArray(context.registry),
                "context should have a registry array",
            );
            // The mock service's `register` mounts nothing, so no service is
            // listed even though its descriptor names EchoService.
            assert.deepStrictEqual(context.services, [], "context should list only services actually mounted");
        });

        it("should give each protocol a frozen snapshot of what was mounted before it: the application services, then the preceding protocols", async () => {
            // The first protocol mounts a service of its own, so the second
            // protocol's view must contain it and the first one's must not.
            const first: ProtocolRegistration & { context?: ProtocolContext } = {
                name: "first",
                setup(context: ProtocolContext) {
                    first.context = context;
                },
                register(router: ConnectRouter) {
                    router.service(StreamingService, {});
                },
            };
            const second = createMockProtocol("second");
            const app: ServiceDefinition = {
                descriptor: EchoService,
                register(router: ConnectRouter) {
                    router.service(EchoService, {});
                },
            };

            const server = createServer({ services: [app], port: 0, protocols: [first, second] });
            servers.push(server);
            await server.start();

            const firstContext = first.context as ProtocolContext;
            const secondContext = second.setupCalls[0] as ProtocolContext;
            assert.deepStrictEqual(firstContext.registry, [EchoService.file]);
            assert.deepStrictEqual(firstContext.services, [EchoService]);
            assert.deepStrictEqual(secondContext.registry, [EchoService.file, StreamingService.file]);
            assert.deepStrictEqual(secondContext.services, [EchoService, StreamingService]);
            // Frozen snapshots: the second registration did not leak back into the first view.
            assert.ok(Object.isFrozen(firstContext.registry));
            assert.ok(Object.isFrozen(firstContext.services));
            assert.ok(Object.isFrozen(secondContext.registry));
            assert.ok(Object.isFrozen(secondContext.services));
        });

        it("should store all protocols on server.protocols", () => {
            const service = createMockService();
            const protocol1 = createMockProtocol("p1");
            const protocol2 = createMockProtocol("p2");

            const server = createServer({
                services: [service],
                protocols: [protocol1, protocol2],
            });
            servers.push(server);

            assert.strictEqual(server.protocols.length, 2);
            assert.strictEqual(server.protocols[0]?.name, "p1");
            assert.strictEqual(server.protocols[1]?.name, "p2");
        });

        it("should work with protocols that have httpHandler", async () => {
            const service = createMockService();

            // The handler claims one path and passes everything else along.
            const protocolWithHttp: ProtocolRegistration = {
                name: "http-protocol",
                register(_router: ConnectRouter) {
                    // no-op
                },
                httpHandler(req, res) {
                    if (req.url !== "/probe") {
                        return false;
                    }
                    res.statusCode = 200;
                    res.end("probe-ok");
                    return true;
                },
            };

            const server = createServer({
                services: [service],
                port: 0,
                protocols: [protocolWithHttp],
            });
            servers.push(server);

            await server.start();
            assert.ok(server.isRunning);

            const base = `http://127.0.0.1:${server.address?.port}`;
            const claimed = await fetch(`${base}/probe`);
            assert.strictEqual(claimed.status, 200);
            assert.strictEqual(await claimed.text(), "probe-ok");
            // A request the handler declines falls through to the server's 404.
            const declined = await fetch(`${base}/other`);
            assert.strictEqual(declined.status, 404);
            await declined.arrayBuffer();

            await server.stop();
            assert.strictEqual(server.state, ServerState.STOPPED);
        });
    });

    // =========================================================================
    // 3. Startup failure cleanup
    // =========================================================================

    describe("startup failure cleanup", () => {
        it("should transition to STOPPED when transport listen fails", async () => {
            const service = createMockService();

            // Start first server to occupy a port
            const server1 = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server1);
            await server1.start();
            const occupiedPort = server1.address?.port;
            assert.ok(occupiedPort, "first server should have an assigned port");

            // Try to start second server on the same port
            const server2 = createServer({
                services: [service],
                port: occupiedPort,
            });
            servers.push(server2);

            const errorHandler = mock.fn();
            server2.on("error", errorHandler);

            await assert.rejects(() => server2.start());

            assert.strictEqual(
                server2.state,
                ServerState.STOPPED,
                "server should transition to STOPPED after startup failure",
            );
        });

        it("should emit error event when transport listen fails", async () => {
            const service = createMockService();

            const server1 = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server1);
            await server1.start();
            const occupiedPort = server1.address?.port;
            assert.ok(occupiedPort);

            const server2 = createServer({
                services: [service],
                port: occupiedPort,
            });
            servers.push(server2);

            const errorHandler = mock.fn();
            server2.on("error", errorHandler);

            await assert.rejects(() => server2.start());

            assert.strictEqual(
                errorHandler.mock.calls.length,
                1,
                "error event should be emitted once",
            );
            const emittedError = errorHandler.mock.calls[0]?.arguments[0];
            assert.ok(emittedError instanceof Error, "emitted error should be an Error instance");
        });

        it("should stop eventBus if transport listen fails after eventBus started", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();

            // Occupy a port
            const server1 = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server1);
            await server1.start();
            const occupiedPort = server1.address?.port;
            assert.ok(occupiedPort);

            // Create server with eventBus on the occupied port
            const server2 = createServer({
                services: [service],
                port: occupiedPort,
                eventBus,
            });
            servers.push(server2);

            server2.on("error", () => {
                // suppress unhandled error
            });

            await assert.rejects(() => server2.start());

            assert.strictEqual(
                eventBus.startFn.mock.calls.length,
                1,
                "eventBus.start() should have been called before transport failure",
            );
            assert.strictEqual(
                eventBus.stopFn.mock.calls.length,
                1,
                "eventBus.stop() should be called to clean up after transport failure",
            );
        });

        it("should not leave server in a broken intermediate state on failure", async () => {
            const service = createMockService();

            const server1 = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server1);
            await server1.start();
            const occupiedPort = server1.address?.port;
            assert.ok(occupiedPort);

            const server2 = createServer({
                services: [service],
                port: occupiedPort,
            });
            servers.push(server2);

            server2.on("error", () => {});

            await assert.rejects(() => server2.start());

            // Server should be in a terminal state, not stuck in STARTING
            assert.strictEqual(server2.state, ServerState.STOPPED);
            assert.strictEqual(server2.isRunning, false);
            assert.strictEqual(server2.address, null);
            // Note: transport object is created during listen() even if binding fails,
            // so it remains non-null. The server state (STOPPED) is the authoritative
            // indicator that the server did not start successfully.
        });

        it("should not leave signal handlers behind when start fails, even with autoShutdown enabled", async () => {
            const service = createMockService();
            const holder = createServer({ services: [service], port: 0 });
            servers.push(holder);
            await holder.start();
            const occupiedPort = holder.address?.port as number;

            const signals = ["SIGTERM", "SIGINT"] as const;
            const before = signals.map((signal) => process.listenerCount(signal));

            const failing = createServer({
                services: [service],
                port: occupiedPort,
                shutdown: { autoShutdown: true },
            });
            servers.push(failing);
            failing.on("error", () => {});
            await assert.rejects(() => failing.start());

            // A server that never started must not intercept the process's signals.
            assert.deepStrictEqual(
                signals.map((signal) => process.listenerCount(signal)),
                before,
            );
            // The failure is local: the server that already holds the port keeps running.
            assert.strictEqual(holder.isRunning, true);
        });
    });

    // =========================================================================
    // 4. Server stop event ordering
    // =========================================================================

    describe("stop event ordering", () => {
        it("should fire 'stopping' before shutdown hooks, and 'stop' after hooks", async () => {
            const service = createMockService();
            const order: string[] = [];

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            server.on("stopping", () => {
                order.push("stopping-event");
            });

            server.onShutdown("cleanup", async () => {
                order.push("shutdown-hook");
            });

            server.on("stop", () => {
                order.push("stop-event");
            });

            await server.start();
            await server.stop();

            assert.deepStrictEqual(order, [
                "stopping-event",
                "shutdown-hook",
                "stop-event",
            ]);
        });

        it("should execute multiple shutdown hooks between stopping and stop events", async () => {
            const service = createMockService();
            const order: string[] = [];

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            server.on("stopping", () => {
                order.push("stopping");
            });

            server.onShutdown("cache", async () => {
                order.push("cache-cleanup");
            });
            server.onShutdown("connections", async () => {
                order.push("connections-cleanup");
            });

            server.on("stop", () => {
                order.push("stop");
            });

            await server.start();
            await server.stop();

            // "stopping" must be first, "stop" must be last
            assert.strictEqual(order[0], "stopping", "stopping event must fire first");
            assert.strictEqual(order[order.length - 1], "stop", "stop event must fire last");

            // Both hooks ran, each once, between stopping and stop
            assert.deepStrictEqual(order.slice(1, -1).sort(), ["cache-cleanup", "connections-cleanup"]);
        });

        it("should execute shutdown hooks with dependency ordering between events", async () => {
            const service = createMockService();
            const order: string[] = [];

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            server.on("stopping", () => {
                order.push("stopping");
            });

            // "database" depends on "cache" — cache runs first, although
            // "database" is registered first and "cache" is slow
            server.onShutdown("database", ["cache"], async () => {
                order.push("database");
            });
            server.onShutdown("cache", async () => {
                await setImmediate();
                order.push("cache");
            });

            server.on("stop", () => {
                order.push("stop");
            });

            await server.start();
            await server.stop();

            assert.deepStrictEqual(order, [
                "stopping",
                "cache",
                "database",
                "stop",
            ]);
        });

        it("should abort shutdownSignal during stop sequence", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            // The shutdown sequence notifies listeners ("stopping") first, then
            // aborts the signal, and only then runs transport close and hooks.
            let abortedAtStopping: boolean | undefined;
            let abortedInHook: boolean | undefined;
            server.on("stopping", () => {
                abortedAtStopping = server.shutdownSignal.aborted;
            });
            server.onShutdown("probe", () => {
                abortedInHook = server.shutdownSignal.aborted;
            });

            await server.start();

            const signal = server.shutdownSignal;
            assert.strictEqual(signal.aborted, false, "signal should not be aborted before stop");

            await server.stop();

            assert.strictEqual(abortedAtStopping, false, "the signal is aborted after the stopping notification, not before");
            assert.strictEqual(abortedInHook, true, "the signal must already be aborted when shutdown hooks run");
            assert.strictEqual(signal.aborted, true, "signal should be aborted after stop completes");
        });
    });

    // =========================================================================
    // 5. Full lifecycle state transitions
    // =========================================================================

    describe("full lifecycle state transitions", () => {
        it("should transition through all states: created -> starting -> running -> stopping -> stopped", async () => {
            const service = createMockService();
            const states: string[] = [];

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            states.push(server.state);

            server.on("start", () => {
                states.push(server.state);
            });
            server.on("ready", () => {
                states.push(server.state);
            });
            server.on("stopping", () => {
                states.push(server.state);
            });
            server.on("stop", () => {
                states.push(server.state);
            });

            await server.start();
            await server.stop();

            assert.deepStrictEqual(states, [
                ServerState.CREATED,
                ServerState.STARTING,
                ServerState.RUNNING,
                ServerState.STOPPING,
                ServerState.STOPPED,
            ]);
        });

        it("should correctly report isRunning at each stage", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            assert.strictEqual(server.isRunning, false, "isRunning should be false when created");

            let isRunningAtReady = false;
            server.on("ready", () => {
                isRunningAtReady = server.isRunning;
            });

            let isRunningAtStopping = false;
            server.on("stopping", () => {
                isRunningAtStopping = server.isRunning;
            });

            await server.start();
            assert.strictEqual(isRunningAtReady, true, "isRunning should be true at ready event");

            await server.stop();
            assert.strictEqual(isRunningAtStopping, false, "isRunning should be false at stopping event");
            assert.strictEqual(server.isRunning, false, "isRunning should be false after stop");
        });

        it("should have address available at ready event and null after stop", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });
            servers.push(server);

            assert.strictEqual(server.address, null, "address should be null before start");

            const state = { addressAtReady: null as { port: number } | null };
            server.on("ready", () => {
                state.addressAtReady = server.address;
            });

            await server.start();
            assert.ok(state.addressAtReady, "address should be available at ready event");
            assert.ok(state.addressAtReady.port > 0, "port should be assigned at ready event");

            await server.stop();
            assert.strictEqual(server.address, null, "address should be null after stop");
        });
    });

    // =========================================================================
    // 6. Combined: eventBus + protocols + shutdown hooks
    // =========================================================================

    describe("combined: eventBus + protocols + shutdown hooks", () => {
        it("should start eventBus, register protocols, and clean up everything on stop", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();
            const protocol = createMockProtocol("test-protocol");
            const order: string[] = [];

            const server = createServer({
                services: [service],
                port: 0,
                eventBus,
                protocols: [protocol],
            });
            servers.push(server);

            server.on("start", () => order.push("start-event"));
            server.on("ready", () => order.push("ready-event"));
            server.on("stopping", () => order.push("stopping-event"));
            server.on("stop", () => order.push("stop-event"));

            server.onShutdown("custom-cleanup", async () => {
                order.push("custom-hook");
            });

            await server.start();

            // Verify setup phase
            assert.strictEqual(eventBus.startFn.mock.calls.length, 1, "eventBus should be started");
            assert.strictEqual(protocol.registerCalls.length, 1, "protocol should be registered");
            assert.ok(server.isRunning, "server should be running");

            await server.stop();

            // Verify teardown phase
            assert.strictEqual(eventBus.stopFn.mock.calls.length, 1, "eventBus should be stopped");
            assert.strictEqual(server.state, ServerState.STOPPED);

            // Verify event ordering
            // The user hook runs during shutdown, between "stopping" and "stop".
            assert.deepStrictEqual(order, ["start-event", "ready-event", "stopping-event", "custom-hook", "stop-event"]);
        });

        it("should not start server if eventBus.start() fails", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();
            const startError = new Error("NATS connection refused");

            // Override start to reject
            eventBus.start = mock.fn(async () => {
                throw startError;
            });

            // A free port that is known in advance, so that "nothing listens
            // there" can be checked after the failed start.
            const probe = createNetServer();
            await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
            const freePort = (probe.address() as AddressInfo).port;
            await new Promise<void>((resolve) => probe.close(() => resolve()));

            const server = createServer({
                services: [service],
                port: freePort,
                host: "127.0.0.1",
                eventBus,
            });
            servers.push(server);

            const errorHandler = mock.fn();
            server.on("error", errorHandler);

            await assert.rejects(
                () => server.start(),
                (err: Error) => {
                    assert.strictEqual(err.message, "NATS connection refused");
                    return true;
                },
            );

            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(server.isRunning, false);
            assert.strictEqual(
                errorHandler.mock.calls.length,
                1,
                "error event should be emitted on eventBus failure",
            );
            assert.strictEqual(server.address, null);

            // The listener was never opened: nobody accepts connections on the port.
            await assert.rejects(
                new Promise<void>((resolve, reject) => {
                    const socket = connectNet({ port: freePort, host: "127.0.0.1" }, () => {
                        socket.destroy();
                        resolve();
                    });
                    socket.on("error", reject);
                }),
                { code: "ECONNREFUSED" },
            );
        });
    });
});

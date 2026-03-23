/**
 * Server lifecycle integration tests
 *
 * Tests the full server lifecycle including eventBus integration,
 * protocol registration, startup failure cleanup, and event ordering.
 */

import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import type { ConnectRouter } from "@connectrpc/connect";
import { createServer } from "../../src/Server.ts";
import type { EventBusLike, ProtocolContext, ProtocolRegistration, Server, ServiceRoute } from "../../src/types.ts";
import { ServerState } from "../../src/types.ts";

// =============================================================================
// HELPERS
// =============================================================================

/** Create a no-op service route for testing */
const createMockService = (): ServiceRoute => {
    return (_router: ConnectRouter) => {
        // no-op — sufficient for lifecycle tests
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

/** Create a mock protocol with tracked register calls */
function createMockProtocol(name: string): ProtocolRegistration & {
    registerCalls: Array<{ router: ConnectRouter; context: ProtocolContext }>;
} {
    const registerCalls: Array<{ router: ConnectRouter; context: ProtocolContext }> = [];

    return {
        name,
        register(router: ConnectRouter, context: ProtocolContext) {
            registerCalls.push({ router, context });
        },
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
            const protocol = createMockProtocol("test-protocol");

            const server = createServer({
                services: [service],
                port: 0,
                protocols: [protocol],
            });
            servers.push(server);

            await server.start();

            assert.strictEqual(protocol.registerCalls.length, 1);
            const { router } = protocol.registerCalls[0]!;
            assert.ok(router, "protocol should receive a router");
            assert.strictEqual(typeof router.service, "function", "router should have a service method");
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

            assert.strictEqual(protocol.registerCalls.length, 1);
            const { context } = protocol.registerCalls[0]!;
            assert.ok(context, "protocol should receive a context");
            assert.ok(
                Array.isArray(context.registry),
                "context should have a registry array",
            );
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

            const protocolWithHttp: ProtocolRegistration = {
                name: "http-protocol",
                register(_router: ConnectRouter, _context: ProtocolContext) {
                    // no-op
                },
                httpHandler(_req, _res) {
                    return false;
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

            // Both hooks should have executed between stopping and stop
            assert.ok(order.includes("cache-cleanup"), "cache-cleanup hook should execute");
            assert.ok(order.includes("connections-cleanup"), "connections-cleanup hook should execute");
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

            // "database" depends on "cache" — cache runs first
            server.onShutdown("cache", async () => {
                order.push("cache");
            });
            server.onShutdown("database", ["cache"], async () => {
                order.push("database");
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

            await server.start();

            const signal = server.shutdownSignal;
            assert.strictEqual(signal.aborted, false, "signal should not be aborted before stop");

            await server.stop();

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
            assert.strictEqual(order[0], "start-event");
            assert.strictEqual(order[1], "ready-event");
            assert.strictEqual(order[2], "stopping-event");
            assert.strictEqual(order[order.length - 1], "stop-event");
        });

        it("should not start server if eventBus.start() fails", async () => {
            const service = createMockService();
            const eventBus = createMockEventBus();
            const startError = new Error("NATS connection refused");

            // Override start to reject
            eventBus.start = mock.fn(async () => {
                throw startError;
            });

            const server = createServer({
                services: [service],
                port: 0,
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
        });
    });
});

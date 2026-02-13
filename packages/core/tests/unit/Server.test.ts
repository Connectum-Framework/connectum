/**
 * Server API tests (PRD v1.1)
 *
 * Tests for the new explicit lifecycle Server API.
 */

import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import type { ConnectRouter } from "@connectrpc/connect";
import { createServer } from "../../src/Server.ts";
import type { Server, ServiceRoute } from "../../src/types.ts";
import { ServerState } from "../../src/types.ts";

// Mock service for testing
const createMockService = (): ServiceRoute => {
    return (_router: ConnectRouter) => {
        // Mock service registration - no actual service needed for unit tests
    };
};

describe("createServer", () => {
    let servers: Server[] = [];

    afterEach(async () => {
        // Cleanup all servers
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

    describe("factory function", () => {
        it("should return unstarted server synchronously", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            assert.ok(server);
            assert.strictEqual(server.state, ServerState.CREATED);
            assert.strictEqual(server.isRunning, false);
            assert.strictEqual(server.address, null);
            assert.strictEqual(server.transport, null);
        });

        it("should store service routes", () => {
            const service1 = createMockService();
            const service2 = createMockService();

            const server = createServer({
                services: [service1, service2],
            });

            servers.push(server);

            assert.strictEqual(server.routes.length, 2);
        });
    });

    describe("start() lifecycle", () => {
        it("should start server and change state to RUNNING", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await server.start();

            assert.strictEqual(server.state, ServerState.RUNNING);
            assert.strictEqual(server.isRunning, true);
            assert.ok(server.address);
            assert.ok(server.address.port > 0);
            assert.ok(server.transport);
        });

        it("should emit start and ready events", async () => {
            const service = createMockService();
            const startHandler = mock.fn();
            const readyHandler = mock.fn();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            server.on("start", startHandler);
            server.on("ready", readyHandler);

            await server.start();

            assert.strictEqual(startHandler.mock.calls.length, 1);
            assert.strictEqual(readyHandler.mock.calls.length, 1);
        });

        it("should throw if called when not in CREATED state", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await server.start();

            await assert.rejects(
                () => server.start(),
                /Cannot start server: current state is "running"/,
            );
        });
    });

    describe("stop() lifecycle", () => {
        it("should stop server and change state to STOPPED", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            await server.start();
            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(server.isRunning, false);
            assert.strictEqual(server.address, null);
            assert.strictEqual(server.transport, null);
        });

        it("should emit stop event", async () => {
            const service = createMockService();
            const stopHandler = mock.fn();

            const server = createServer({
                services: [service],
                port: 0,
            });

            server.on("stop", stopHandler);

            await server.start();
            await server.stop();

            assert.strictEqual(stopHandler.mock.calls.length, 1);
        });

        it("should throw if called when not in RUNNING state", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            await assert.rejects(
                () => server.stop(),
                /Cannot stop server: current state is "created"/,
            );
        });

        it("should handle concurrent stop() calls by returning same promise", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await server.start();

            // Call stop() twice simultaneously
            const stopPromise1 = server.stop();
            const stopPromise2 = server.stop();

            // Both should resolve without error
            await Promise.all([stopPromise1, stopPromise2]);

            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(server.isRunning, false);
        });

        it("should throw if called after already stopped", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            await server.start();
            await server.stop();

            await assert.rejects(
                () => server.stop(),
                /Cannot stop server: current state is "stopped"/,
            );
        });
    });

    describe("addService()", () => {
        it("should add service before start", () => {
            const service1 = createMockService();
            const service2 = createMockService();

            const server = createServer({
                services: [service1],
            });

            servers.push(server);

            assert.strictEqual(server.routes.length, 1);

            server.addService(service2);

            assert.strictEqual(server.routes.length, 2);
        });

        it("should throw if server is already running", async () => {
            const service1 = createMockService();
            const service2 = createMockService();

            const server = createServer({
                services: [service1],
                port: 0,
            });

            servers.push(server);

            await server.start();

            assert.throws(
                () => server.addService(service2),
                /Cannot add service: server is already running/,
            );
        });
    });

    describe("protocols", () => {
        it("should accept protocols array", () => {
            const service = createMockService();

            const mockProtocol = {
                name: "test-protocol",
                register(_router: ConnectRouter) {
                    // no-op
                },
            };

            const server = createServer({
                services: [service],
                protocols: [mockProtocol],
            });

            servers.push(server);

            assert.ok(server);
            assert.strictEqual(server.state, ServerState.CREATED);
        });

        it("should default to empty protocols when none specified", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await server.start();
            assert.ok(server.isRunning);
        });
    });

    describe("configuration options", () => {
        it("should use custom port", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await server.start();

            assert.ok(server.address);
            assert.ok(server.address.port > 0);
        });

        it("should use custom host", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
                host: "127.0.0.1",
            });

            servers.push(server);

            await server.start();

            assert.strictEqual(server.address?.address, "127.0.0.1");
        });

        it("should accept custom interceptors", async () => {
            const service = createMockService();
            const customInterceptor = mock.fn((next) => next);

            const server = createServer({
                services: [service],
                port: 0,
                interceptors: [customInterceptor],
            });

            servers.push(server);

            await server.start();

            assert.ok(server.isRunning);
        });
    });

    describe("event emitter", () => {
        it("should support once() for one-time listeners", async () => {
            const service = createMockService();
            const readyHandler = mock.fn();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            server.once("ready", readyHandler);

            await server.start();

            // Handler should have been called once
            assert.strictEqual(readyHandler.mock.calls.length, 1);
        });

        it("should support off() to remove listeners", async () => {
            const service = createMockService();
            const readyHandler = mock.fn();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            server.on("ready", readyHandler);
            server.off("ready", readyHandler);

            await server.start();

            // Handler should not have been called
            assert.strictEqual(readyHandler.mock.calls.length, 0);
        });

        it("should emit error event on startup failure", async () => {
            const service = createMockService();

            // Start first server to occupy a port
            const server1 = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server1);

            await server1.start();
            const occupiedPort = server1.address?.port;
            assert.ok(occupiedPort);

            // Try to start second server on same port
            const server2 = createServer({
                services: [service],
                port: occupiedPort,
            });

            servers.push(server2);

            const errorHandler = mock.fn();
            server2.on("error", errorHandler);

            await assert.rejects(() => server2.start());

            assert.strictEqual(errorHandler.mock.calls.length, 1);
        });
    });

    describe("readonly properties", () => {
        it("routes should be readonly array", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            // TypeScript enforces this at compile time, but we verify behavior
            assert.ok(Array.isArray(server.routes));
            assert.strictEqual(server.routes.length, 1);
        });
    });

    describe("addInterceptor()", () => {
        it("should add interceptor before start", () => {
            const service = createMockService();
            const customInterceptor = mock.fn((next) => next);

            const server = createServer({
                services: [service],
                interceptors: [],
            });

            servers.push(server);

            const initialLength = server.interceptors.length;
            server.addInterceptor(customInterceptor);

            assert.strictEqual(server.interceptors.length, initialLength + 1);
        });

        it("should throw if server is already running", async () => {
            const service = createMockService();
            const customInterceptor = mock.fn((next) => next);

            const server = createServer({
                services: [service],
                port: 0,
                interceptors: [],
            });

            servers.push(server);

            await server.start();

            assert.throws(
                () => server.addInterceptor(customInterceptor),
                /Cannot add interceptor: server is already running/,
            );
        });
    });

    describe("addProtocol()", () => {
        it("should add protocol before start", () => {
            const service = createMockService();

            const mockProtocol = {
                name: "test-protocol",
                register(_router: ConnectRouter) {
                    // no-op
                },
            };

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            const initialLength = server.protocols.length;
            server.addProtocol(mockProtocol);

            assert.strictEqual(server.protocols.length, initialLength + 1);
        });

        it("should throw if server is already running", async () => {
            const service = createMockService();

            const mockProtocol = {
                name: "test-protocol",
                register(_router: ConnectRouter) {
                    // no-op
                },
            };

            const server = createServer({
                services: [service],
                port: 0,
                interceptors: [],
            });

            servers.push(server);

            await server.start();

            assert.throws(
                () => server.addProtocol(mockProtocol),
                /Cannot add protocol: server is already running/,
            );
        });
    });

    describe("interceptors getter", () => {
        it("should return empty array when no interceptors specified", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            assert.ok(Array.isArray(server.interceptors));
            assert.strictEqual(server.interceptors.length, 0);
        });

        it("should return empty array when interceptors: []", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                interceptors: [],
            });

            servers.push(server);

            assert.strictEqual(server.interceptors.length, 0);
        });

        it("should return only custom interceptors when provided", () => {
            const service = createMockService();
            const customInterceptor = mock.fn((next) => next);

            const server = createServer({
                services: [service],
                interceptors: [customInterceptor],
            });

            servers.push(server);

            assert.strictEqual(server.interceptors.length, 1);
        });
    });

    describe("protocols getter", () => {
        it("should return empty array when no protocols specified", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            assert.ok(Array.isArray(server.protocols));
            assert.strictEqual(server.protocols.length, 0);
        });

        it("should return protocols when specified", () => {
            const service = createMockService();

            const mockProtocol = {
                name: "test-protocol",
                register(_router: ConnectRouter) {
                    // no-op
                },
            };

            const server = createServer({
                services: [service],
                protocols: [mockProtocol],
            });

            servers.push(server);

            assert.strictEqual(server.protocols.length, 1);
        });
    });

    describe("graceful shutdown", () => {
        describe("shutdownSignal", () => {
            it("should return an AbortSignal", () => {
                const service = createMockService();

                const server = createServer({
                    services: [service],
                });

                servers.push(server);

                assert.ok(server.shutdownSignal instanceof AbortSignal);
                assert.strictEqual(server.shutdownSignal.aborted, false);
            });

            it("should be aborted when server stops", async () => {
                const service = createMockService();

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                servers.push(server);

                await server.start();

                const signal = server.shutdownSignal;
                assert.strictEqual(signal.aborted, false);

                await server.stop();

                assert.strictEqual(signal.aborted, true);
            });
        });

        describe("stopping event", () => {
            it("should emit stopping event before stop", async () => {
                const service = createMockService();
                const stoppingHandler = mock.fn();
                const stopHandler = mock.fn();

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                servers.push(server);

                server.on("stopping", stoppingHandler);
                server.on("stop", stopHandler);

                await server.start();
                await server.stop();

                assert.strictEqual(stoppingHandler.mock.calls.length, 1);
                assert.strictEqual(stopHandler.mock.calls.length, 1);
            });
        });

        describe("onShutdown()", () => {
            it("should register and execute shutdown hooks", async () => {
                const service = createMockService();
                const order: string[] = [];

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                servers.push(server);

                server.onShutdown("cache", async () => {
                    order.push("cache");
                });
                server.onShutdown("database", ["cache"], async () => {
                    order.push("database");
                });

                await server.start();
                await server.stop();

                assert.deepStrictEqual(order, ["cache", "database"]);
            });

            it("should execute anonymous hooks", async () => {
                const service = createMockService();
                let hookCalled = false;

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                servers.push(server);

                server.onShutdown(() => {
                    hookCalled = true;
                });

                await server.start();
                await server.stop();

                assert.strictEqual(hookCalled, true);
            });

            it("should throw if server is already stopped", async () => {
                const service = createMockService();

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                await server.start();
                await server.stop();

                assert.throws(
                    () => server.onShutdown(() => {}),
                    /Cannot add shutdown hook: server is already stopped/,
                );
            });
        });
    });
});

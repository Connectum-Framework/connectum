/**
 * Server API tests (PRD v1.1)
 *
 * Tests for the new explicit lifecycle Server API.
 */

import assert from "node:assert";
import net from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import type { ServiceDefinition } from "../../src/defineService.ts";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { Server } from "../../src/types.ts";
import { ServerState } from "../../src/types.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

// Mock service for testing.
//
// These lifecycle/state unit tests never invoke an RPC, so the service must
// register NOTHING (mirrors the previous `(router) => {}` no-op route). The
// descriptor is required by `ServiceDefinition` but unused: `register` is a
// no-op, so `EchoService` is never mounted and `hasService`/registry stay empty.
const createMockService = (): ServiceDefinition => {
    return {
        descriptor: EchoService,
        register: () => {
            // Mock service registration - no actual service needed for unit tests
        },
    };
};

/** Whether a TCP connection to the loopback port is accepted (false when it is refused). */
function acceptsConnections(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

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
            // The registered routes are the very services that were passed in, in order.
            assert.strictEqual(server.routes[0], service1);
            assert.strictEqual(server.routes[1], service2);
        });

        it("should keep registration order when services are added later", () => {
            const first = createMockService();
            const second = createMockService();
            const third = createMockService();

            const server = createServer({ services: [first, second] });
            servers.push(server);
            server.addService(third);

            assert.strictEqual(server.routes.length, 3);
            assert.strictEqual(server.routes[0], first);
            assert.strictEqual(server.routes[1], second);
            assert.strictEqual(server.routes[2], third);
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

        // Port 0 asks the operating system for a free port (Node.js net.Server.listen),
        // so two servers started on it can never share one. A silent fallback to a fixed
        // default port would make the second start fail or both land on the same port.
        it("should give servers started on port 0 different operating-system ports", async () => {
            const first = createServer({ services: [createMockService()], port: 0 });
            const second = createServer({ services: [createMockService()], port: 0 });
            servers.push(first, second);

            await first.start();
            await second.start();

            assert.ok(first.address?.port);
            assert.ok(second.address?.port);
            assert.notStrictEqual(first.address.port, second.address.port);
        });

        it("should emit start and ready events in order, each in the state the lifecycle guide gives it", async () => {
            const service = createMockService();
            const seen: Array<{ event: string; state: ServerState; listening: boolean | undefined; port: number | undefined }> = [];

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            const record = (event: string) => () => {
                seen.push({ event, state: server.state, listening: server.transport?.listening, port: server.address?.port });
            };
            server.on("start", record("start"));
            server.on("ready", record("ready"));

            await server.start();

            assert.deepStrictEqual(
                seen.map((entry) => entry.event),
                ["start", "ready"],
            );
            // "start" fires while the server is starting and nothing listens yet.
            assert.strictEqual(seen[0]?.state, ServerState.STARTING);
            assert.notStrictEqual(seen[0]?.listening, true);
            // "ready" is the transition into running, with the port already bound.
            assert.strictEqual(seen[1]?.state, ServerState.RUNNING);
            assert.strictEqual(seen[1]?.listening, true);
            assert.strictEqual(seen[1]?.port, server.address?.port);
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
            const port = server.address?.port;
            assert.ok(port);
            assert.strictEqual(await acceptsConnections(port), true, "the port must accept connections while running");

            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(server.isRunning, false);
            assert.strictEqual(server.address, null);
            assert.strictEqual(server.transport, null);
            // "stopped" means the listener is closed and the port is released.
            assert.strictEqual(await acceptsConnections(port), false, "the port must be released after stop()");
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

        // Oracle: the server-graceful-shutdown contract ("Repeated stop is deterministic
        // and does not fail", scenario "Stop before start") and the graceful-shutdown guide
        // ("Repeated stop() calls"): stop() on a server that was never started REJECTS,
        // because it is a lifecycle mistake and not a repeat. Neither source prescribes
        // the message text, so only the rejection and its type are asserted. That the
        // rejected call leaves the server in CREATED and still startable is a Connectum
        // decision (no documented source): a lifecycle mistake is not a transition.
        it("should reject stop() on a server that was never started", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await assert.rejects(() => server.stop(), Error);
            assert.strictEqual(server.state, ServerState.CREATED);

            await server.start();
            assert.strictEqual(server.state, ServerState.RUNNING);
        });

        it("should handle concurrent stop() calls by returning same promise", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            const events: string[] = [];
            server.on("stopping", () => events.push("stopping"));
            server.on("stop", () => events.push("stop"));
            const hook = mock.fn(async () => {});
            server.onShutdown("once", hook);

            await server.start();

            // Call stop() twice simultaneously
            const stopPromise1 = server.stop();
            const stopPromise2 = server.stop();

            // Both should resolve without error
            await Promise.all([stopPromise1, stopPromise2]);

            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(server.isRunning, false);
            // "Concurrent calls return the same Promise": one shutdown serves both
            // callers, so the sequence ran once, not twice.
            assert.deepStrictEqual(events, ["stopping", "stop"]);
            assert.strictEqual(hook.mock.calls.length, 1);
        });

        // Contract (graceful-shutdown guide, "Idempotent stop()"): stop() is safe to
        // call any number of times. After the first call the server is STOPPED and
        // later calls neither throw nor repeat the shutdown.
        it("resolves without error and without repeating the shutdown when called again after stopping", async () => {
            const server = createServer({
                services: [createMockService()],
                port: 0,
            });
            const events: string[] = [];
            server.on("stopping", () => events.push("stopping"));
            server.on("stop", () => events.push("stop"));
            server.on("error", () => events.push("error"));

            await server.start();
            await server.stop();
            await server.stop();
            await server.stop();

            assert.deepStrictEqual(events, ["stopping", "stop"]);
            assert.strictEqual(server.state, ServerState.STOPPED);
        });

        it("runs a registered shutdown hook exactly once across repeated stop() calls", async () => {
            const server = createServer({
                services: [createMockService()],
                port: 0,
            });
            const hook = mock.fn(async () => {});
            server.onShutdown("once", hook);

            await server.start();
            await Promise.all([server.stop(), server.stop()]);
            await server.stop();

            assert.strictEqual(hook.mock.calls.length, 1);
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
            assert.strictEqual(server.routes[1], service2);
        });

        it("should serve a service added before start", async () => {
            const server = createServer({ services: [] });
            servers.push(server);
            server.addService(
                defineService(EchoService, {
                    echo: (request) => create(EchoResponseSchema, { message: `added:${request.message}`, timestamp: 0n }),
                    secureEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                    rateLimitedEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                }),
            );

            const response = await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "x" }));

            assert.strictEqual(response.message, "added:x");
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
        // Route materialization contract: `register(router)` is called once per router built,
        // and a started server has built exactly one, the HTTP adapter's.
        it("should register the protocols given in the options on the HTTP router, once each, in order", async () => {
            const registered: string[] = [];
            const protocol = (name: string) => ({
                name,
                register() {
                    registered.push(name);
                },
            });
            const server = createServer({ services: [createMockService()], port: 0, protocols: [protocol("first"), protocol("second")] });
            servers.push(server);
            assert.deepStrictEqual(registered, [], "a protocol is not registered before the routes are built");

            await server.start();

            assert.deepStrictEqual(registered, ["first", "second"]);
        });
    });

    describe("configuration options", () => {
        // Port 0 only asks the operating system for any free port, so it cannot show that
        // an explicit port is honoured: a concrete, previously free port must come back.
        it("should listen on the explicit port that was configured", async () => {
            const probe = net.createServer();
            await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
            const freePort = (probe.address() as net.AddressInfo).port;
            await new Promise<void>((resolve) => probe.close(() => resolve()));

            const server = createServer({
                services: [createMockService()],
                port: freePort,
                host: "127.0.0.1",
            });
            servers.push(server);

            await server.start();

            assert.strictEqual(server.address?.port, freePort);
            assert.strictEqual(await acceptsConnections(freePort), true);
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

        it("should run the interceptors given in the options, outermost first, on every call", async () => {
            const seen: string[] = [];
            const tag = (name: string): Interceptor => (next) => async (request) => {
                seen.push(`${name}:${request.method.name}`);
                return next(request);
            };
            const server = createServer({
                services: [
                    defineService(EchoService, {
                        echo: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                        secureEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                        rateLimitedEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                    }),
                ],
                port: 0,
                interceptors: [tag("outer"), tag("inner")],
            });
            servers.push(server);
            await server.start();

            await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));

            assert.deepStrictEqual(seen, ["outer:Echo", "inner:Echo"]);
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

            const reported: unknown[] = [];
            const events: string[] = [];
            server2.on("start", () => events.push("start"));
            server2.on("ready", () => events.push("ready"));
            server2.on("error", (err) => {
                events.push("error");
                reported.push(err);
            });

            const rejection = await server2.start().then(
                () => undefined,
                (err: unknown) => err,
            );

            // The failure is the bind error of the occupied port, and the error event
            // carries that same object that start() rejected with.
            assert.ok(rejection instanceof Error);
            assert.strictEqual((rejection as NodeJS.ErrnoException).code, "EADDRINUSE");
            assert.deepStrictEqual(reported, [rejection]);
            // Lifecycle guide: a failure before the server is listening is `start → error`,
            // and the server ends up stopped.
            assert.deepStrictEqual(events, ["start", "error"]);
            assert.strictEqual(server2.state, ServerState.STOPPED);
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
            assert.strictEqual(server.interceptors.at(-1), customInterceptor);
        });

        it("should run an interceptor added before start on every call", async () => {
            const seenMethods: string[] = [];
            const server = createServer({
                services: [
                    defineService(EchoService, {
                        echo: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                        secureEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                        rateLimitedEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
                    }),
                ],
            });
            servers.push(server);
            server.addInterceptor((next) => async (request) => {
                seenMethods.push(request.method.name);
                return next(request);
            });

            const client = server.localClient(EchoService);
            await client.echo(create(EchoRequestSchema, { message: "a" }));
            await client.echo(create(EchoRequestSchema, { message: "b" }));

            assert.deepStrictEqual(seenMethods, ["Echo", "Echo"]);
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
            assert.strictEqual(server.protocols.at(-1), mockProtocol);
        });

        it("should register a protocol added before start when the server starts", async () => {
            let registerCalls = 0;
            const server = createServer({ services: [createMockService()], port: 0 });
            servers.push(server);
            server.addProtocol({
                name: "counting",
                register() {
                    registerCalls++;
                },
            });
            assert.strictEqual(registerCalls, 0, "a protocol is not registered before the routes are built");

            await server.start();

            assert.strictEqual(registerCalls, 1, "the added protocol is registered once, on the HTTP router");
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

        it("should keep the given interceptors in the given order", () => {
            const first = mock.fn((next) => next);
            const second = mock.fn((next) => next);

            const server = createServer({
                services: [createMockService()],
                interceptors: [first, second],
            });
            servers.push(server);

            assert.strictEqual(server.interceptors.length, 2);
            assert.strictEqual(server.interceptors[0], first);
            assert.strictEqual(server.interceptors[1], second);
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
            assert.strictEqual(server.protocols[0], mockProtocol);
        });
    });

    describe("eventBus property", () => {
        it("should return null when not configured", () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
            });

            servers.push(server);

            assert.strictEqual(server.eventBus, null);
        });

        it("should return bus instance when configured", () => {
            const service = createMockService();
            const mockEventBus = {
                start: mock.fn(async () => {}),
                stop: mock.fn(async () => {}),
            };

            const server = createServer({
                services: [service],
                eventBus: mockEventBus,
            });

            servers.push(server);

            assert.strictEqual(server.eventBus, mockEventBus);
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

            // Graceful-shutdown guide, "Shutdown Sequence": the abort signal (step 2)
            // precedes the transport close (step 3), so long-running handlers are asked to
            // stop while the listener is still up. The abort event is observed from the
            // outside: at that instant the transport must still be listening.
            it("should abort before the transport is closed", async () => {
                const server = createServer({
                    services: [createMockService()],
                    port: 0,
                });
                servers.push(server);
                await server.start();

                let listeningAtAbort: boolean | undefined;
                server.shutdownSignal.addEventListener("abort", () => {
                    listeningAtAbort = server.transport?.listening;
                });

                await server.stop();

                assert.strictEqual(listeningAtAbort, true, "the shutdown signal must be aborted while the transport still listens");
            });

            // The signal is aborted right AFTER the `stopping` event: a `stopping`
            // listener still sees it un-aborted, and reacts to the abort through an
            // `abort` listener, which runs once the `stopping` listeners are done.
            it("should abort only after the stopping listeners have run", async () => {
                const server = createServer({
                    services: [createMockService()],
                    port: 0,
                });
                servers.push(server);
                await server.start();

                const order: string[] = [];
                let abortedInStopping: boolean | undefined;
                server.on("stopping", () => {
                    abortedInStopping = server.shutdownSignal.aborted;
                    order.push("stopping-listener");
                });
                server.shutdownSignal.addEventListener("abort", () => {
                    order.push("abort");
                });

                await server.stop();

                assert.strictEqual(abortedInStopping, false, "inside a stopping listener the signal is not yet aborted");
                assert.deepStrictEqual(order, ["stopping-listener", "abort"]);
            });

            it("should stay the same signal object for the whole life of the server", async () => {
                const server = createServer({
                    services: [createMockService()],
                    port: 0,
                });
                servers.push(server);

                const before = server.shutdownSignal;
                await server.start();
                const running = server.shutdownSignal;
                await server.stop();

                assert.strictEqual(running, before);
                assert.strictEqual(server.shutdownSignal, before);
                assert.strictEqual(before.aborted, true);
            });
        });

        // Graceful-shutdown guide, "Automatic vs Manual Shutdown": `autoShutdown` defaults to
        // false (no signal handlers are installed); with `autoShutdown: true` the signals
        // default to SIGTERM and SIGINT, and the handlers are gone once the server has stopped.
        describe("automatic shutdown signals", () => {
            const counts = () => ({ SIGTERM: process.listenerCount("SIGTERM"), SIGINT: process.listenerCount("SIGINT"), SIGWINCH: process.listenerCount("SIGWINCH") });

            it("should install no signal handlers unless autoShutdown is enabled", async () => {
                const before = counts();
                const server = createServer({ services: [createMockService()], port: 0 });
                servers.push(server);

                await server.start();

                assert.deepStrictEqual(counts(), before);
            });

            it("should handle SIGTERM and SIGINT by default and release both handlers on stop", async () => {
                const before = counts();
                const server = createServer({ services: [createMockService()], port: 0, shutdown: { autoShutdown: true } });
                servers.push(server);

                await server.start();

                assert.deepStrictEqual(counts(), { SIGTERM: before.SIGTERM + 1, SIGINT: before.SIGINT + 1, SIGWINCH: before.SIGWINCH });

                await server.stop();

                assert.deepStrictEqual(counts(), before);
            });

            it("should handle only the configured signals instead of the defaults", async () => {
                const before = counts();
                const server = createServer({ services: [createMockService()], port: 0, shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
                servers.push(server);

                await server.start();

                assert.deepStrictEqual(counts(), { ...before, SIGWINCH: before.SIGWINCH + 1 });
            });
        });

        describe("stopping event", () => {
            // Graceful-shutdown guide: "stopping" is step 1, before the transport closes,
            // so a listener can still flip the health status while connections are served;
            // "stop" is the last step, after the server is fully stopped.
            it("should emit stopping while the transport still listens and stop after it is released", async () => {
                const server = createServer({
                    services: [createMockService()],
                    port: 0,
                });
                servers.push(server);
                let atStopping: { state: ServerState; listening: boolean | undefined; port: number | undefined } | undefined;
                let atStop: { state: ServerState; address: unknown; transport: unknown } | undefined;
                server.on("stopping", () => {
                    atStopping = { state: server.state, listening: server.transport?.listening, port: server.address?.port };
                });
                server.on("stop", () => {
                    atStop = { state: server.state, address: server.address, transport: server.transport };
                });

                await server.start();
                await server.stop();

                assert.strictEqual(atStopping?.state, ServerState.STOPPING);
                assert.strictEqual(atStopping?.listening, true);
                assert.ok(atStopping?.port);
                assert.strictEqual(atStop?.state, ServerState.STOPPED);
                assert.strictEqual(atStop?.address, null);
                assert.strictEqual(atStop?.transport, null);
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

                // The dependent hook is registered FIRST, so the registration order is
                // the opposite of the required order: only the dependency edge
                // ("Dependencies execute first") can put `cache` ahead of `database`.
                server.onShutdown("database", ["cache"], async () => {
                    order.push("database");
                });
                server.onShutdown("cache", async () => {
                    order.push("cache");
                });

                await server.start();
                await server.stop();

                assert.deepStrictEqual(order, ["cache", "database"]);
            });

            // Graceful-shutdown guide, "Shutdown Sequence": hooks are step 6, after the
            // abort signal (step 2) and the transport close (step 3).
            it("should run hooks after the shutdown signal is aborted and the transport is closed", async () => {
                const server = createServer({
                    services: [createMockService()],
                    port: 0,
                });
                servers.push(server);
                let atHook: { aborted: boolean; listening: boolean | undefined } | undefined;
                server.onShutdown("probe", () => {
                    atHook = { aborted: server.shutdownSignal.aborted, listening: server.transport?.listening };
                });

                await server.start();
                await server.stop();

                assert.deepStrictEqual(atHook, { aborted: true, listening: false });
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

            // Connectum decision, no documented source: the guides and contracts say nothing
            // about registering a hook on a stopped server. What is documented is that a
            // repeated stop() "does not run the shutdown hooks again" (graceful-shutdown
            // guide, "Repeated stop() calls"), so a hook added after the stop could never
            // run. The chosen policy is to fail loudly at registration instead of letting
            // the hook be accepted and silently never executed. The test therefore pins two
            // consequences: registration throws, and the later stop() really does not run it.
            it("should refuse a hook registered after stop, which would otherwise never run", async () => {
                const service = createMockService();

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                await server.start();
                await server.stop();

                const lateHook = mock.fn();
                assert.throws(() => server.onShutdown(lateHook), Error);

                await server.stop();
                assert.strictEqual(lateHook.mock.calls.length, 0);
            });
        });

        describe("stopping event order", () => {
            it("should emit 'stopping' event BEFORE 'stop' event", async () => {
                const service = createMockService();
                const eventOrder: string[] = [];

                const server = createServer({
                    services: [service],
                    port: 0,
                });

                servers.push(server);

                server.on("stopping", () => {
                    eventOrder.push("stopping");
                });
                server.on("stop", () => {
                    eventOrder.push("stop");
                });

                await server.start();
                await server.stop();

                assert.strictEqual(eventOrder[0], "stopping");
                assert.strictEqual(eventOrder[1], "stop");
                assert.strictEqual(eventOrder.length, 2);
            });
        });
    });

    describe("addService/addInterceptor/addProtocol in CREATED state", () => {
        it("should allow addService(), addInterceptor(), addProtocol() in CREATED state", () => {
            const service = createMockService();
            const extraService = createMockService();
            const customInterceptor = mock.fn((next) => next);
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

            assert.strictEqual(server.state, ServerState.CREATED);

            // All three should NOT throw in CREATED state
            assert.doesNotThrow(() => server.addService(extraService));
            assert.doesNotThrow(() => server.addInterceptor(customInterceptor));
            assert.doesNotThrow(() => server.addProtocol(mockProtocol));

            assert.strictEqual(server.routes.length, 2);
            assert.strictEqual(server.interceptors.length, 1);
            assert.strictEqual(server.protocols.length, 1);
        });
    });

    describe("start() from STOPPED state", () => {
        // Lifecycle contract: a stopped server cannot be restarted, and a server whose
        // start failed is stopped, so the same rule applies to it.
        it("should not allow a retry after a failed start", async () => {
            const blocker = createServer({ services: [createMockService()], port: 0 });
            servers.push(blocker);
            await blocker.start();
            const server = createServer({ services: [createMockService()], port: blocker.address?.port ?? 0 });
            servers.push(server);
            server.on("error", () => {});
            await assert.rejects(() => server.start(), { code: "EADDRINUSE" });
            assert.strictEqual(server.state, ServerState.STOPPED);
            await blocker.stop();

            await assert.rejects(() => server.start(), Error);

            assert.strictEqual(server.state, ServerState.STOPPED);
        });

        it("should throw when calling start() after stop()", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            await server.start();
            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);

            await assert.rejects(
                () => server.start(),
                /Cannot start server: current state is "stopped"/,
            );
        });
    });

    // Oracle: the registration-API ADR states that addService(), addInterceptor() and
    // addProtocol() "can only be called in the CREATED state (before start())" and
    // "throw Error" otherwise, and appends the element only on success. A STOPPED server
    // is not in CREATED, so each call must throw and must not change the registered
    // lists. The ADR names only a running server in its second bullet; the stopped case
    // follows from the first bullet. The message text exists only in the implementation,
    // so the assertions check the error type and the unchanged lists, not the wording.
    describe("addService/addInterceptor/addProtocol from STOPPED state", () => {
        it("should throw when calling addService() after stop()", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            await server.start();
            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);
            const routesBefore = server.routes.length;

            assert.throws(() => server.addService(createMockService()), Error);
            assert.strictEqual(server.routes.length, routesBefore);
        });

        it("should throw when calling addInterceptor() after stop()", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            await server.start();
            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);
            const interceptorsBefore = server.interceptors.length;

            assert.throws(() => server.addInterceptor(mock.fn((next) => next)), Error);
            assert.strictEqual(server.interceptors.length, interceptorsBefore);
        });

        it("should throw when calling addProtocol() after stop()", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            await server.start();
            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);
            const protocolsBefore = server.protocols.length;

            assert.throws(
                () =>
                    server.addProtocol({
                        name: "test-protocol",
                        register(_router: ConnectRouter) {
                            // no-op
                        },
                    }),
                Error,
            );
            assert.strictEqual(server.protocols.length, protocolsBefore);
        });
    });

    describe("eventBus error during start()", () => {
        it("should emit error event when eventBus.start() throws", async () => {
            const service = createMockService();
            const busError = new Error("connection refused");
            const mockEventBus = {
                start: mock.fn(async () => {
                    throw busError;
                }),
                stop: mock.fn(async () => {}),
            };

            const server = createServer({
                services: [service],
                port: 0,
                eventBus: mockEventBus,
            });

            servers.push(server);

            const events: string[] = [];
            const reported: unknown[] = [];
            server.on("start", () => events.push("start"));
            server.on("ready", () => events.push("ready"));
            server.on("error", (err) => {
                events.push("error");
                reported.push(err);
            });

            await assert.rejects(
                () => server.start(),
                (err: unknown) => err === busError,
            );

            // The lifecycle guide: a startup failure before the server listens is
            // `start → error`, the error event carries the original failure, and the
            // server ends up stopped without ever having bound a port.
            assert.deepStrictEqual(events, ["start", "error"]);
            assert.deepStrictEqual(reported, [busError]);
            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(server.address, null);
            assert.strictEqual(server.transport, null);
        });
    });

    describe("concurrent start() calls", () => {
        it("should reject second start() call while first is in progress", async () => {
            const service = createMockService();

            const server = createServer({
                services: [service],
                port: 0,
            });

            servers.push(server);

            // First start() begins — state transitions to STARTING
            const firstStart = server.start();

            // Second start() should reject because state is no longer CREATED
            await assert.rejects(
                () => server.start(),
                /Cannot start server: current state is "starting"/,
            );

            // Let first start complete
            await firstStart;
            assert.strictEqual(server.state, ServerState.RUNNING);
        });
    });
});

/**
 * Lifecycle listener safety: a throwing listener of a lifecycle event must not
 * leave the server half-started, stuck in "stopping", or holding its port.
 */

import assert from "node:assert";
import { connect } from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import type { ServiceDefinition } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { Server } from "../../src/types.ts";
import { ServerState } from "../../src/types.ts";
import { EchoService } from "../fixtures/echo/v1/echo_pb.ts";

const createMockService = (): ServiceDefinition => ({
    descriptor: EchoService,
    register: () => {},
});

/** True when nothing accepts TCP connections on the port. */
function isPortClosed(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => resolve(true));
    });
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaces a console method with a recorder (`mock.method` is unavailable under Bun). */
function captureConsole(method: "error" | "info"): { readonly calls: unknown[][]; restore(): void } {
    const original = console[method];
    const calls: unknown[][] = [];
    console[method] = (...args: unknown[]) => {
        calls.push(args);
    };
    return {
        calls,
        restore: () => {
            console[method] = original;
        },
    };
}

describe("lifecycle listener safety", () => {
    const servers: Server[] = [];

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            try {
                if (server.isRunning) {
                    await server.stop();
                }
            } catch {
                // cleanup only
            }
        }
    });

    const make = (options: Record<string, unknown> = {}): Server => {
        const server = createServer({ services: [createMockService()], port: 0, ...options });
        servers.push(server);
        return server;
    };

    describe("startup phase", () => {
        it("a throwing ready listener fails start() and releases the port and the signal handlers", async () => {
            const before = process.listenerCount("SIGWINCH");
            const server = make({ shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
            const boom = new Error("ready listener failed");
            let port = 0;
            server.on("ready", () => {
                port = server.address?.port ?? 0;
                throw boom;
            });
            const errors: Error[] = [];
            server.on("error", (err) => errors.push(err));

            await assert.rejects(() => server.start(), boom);

            assert.notStrictEqual(port, 0, "server was listening when ready fired");
            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.strictEqual(await isPortClosed(port), true, "port must be released");
            assert.strictEqual(process.listenerCount("SIGWINCH"), before, "signal handlers must be removed");
            assert.deepStrictEqual(errors, [boom]);
        });

        it("a throwing ready listener rolls the event bus back", async () => {
            const bus = { start: mock.fn(async () => {}), stop: mock.fn(async () => {}) };
            const server = make({ eventBus: bus });
            server.on("ready", () => {
                throw new Error("nope");
            });
            server.on("error", () => {});

            await assert.rejects(() => server.start());

            assert.strictEqual(bus.stop.mock.calls.length, 1);
        });

        it("a throwing start listener fails start() and leaves the state stopped, not starting", async () => {
            const server = make();
            const boom = new Error("start listener failed");
            server.on("start", () => {
                throw boom;
            });
            server.on("error", () => {});

            await assert.rejects(() => server.start(), boom);

            assert.strictEqual(server.state, ServerState.STOPPED);
        });

        it("a throwing ready listener emits start, ready, error and never stopping or stop", async () => {
            const server = make();
            const events: string[] = [];
            server.on("start", () => events.push("start"));
            server.on("stopping", () => events.push("stopping"));
            server.on("stop", () => events.push("stop"));
            server.on("error", () => events.push("error"));
            server.on("ready", () => events.push("ready"));
            server.on("ready", () => {
                throw new Error("ready failed");
            });

            await assert.rejects(() => server.start());

            assert.deepStrictEqual(events, ["start", "ready", "error"]);
        });

        it("a throwing start listener emits start then error, with no ready, stopping or stop", async () => {
            const server = make();
            const events: string[] = [];
            server.on("start", () => events.push("start"));
            server.on("start", () => {
                throw new Error("start failed");
            });
            server.on("ready", () => events.push("ready"));
            server.on("stopping", () => events.push("stopping"));
            server.on("stop", () => events.push("stop"));
            server.on("error", () => events.push("error"));

            await assert.rejects(() => server.start());

            assert.deepStrictEqual(events, ["start", "error"]);
        });
    });

    describe("shutdown phase", () => {
        it("a throwing stopping listener does not block the shutdown or the next listener", async () => {
            const server = make();
            const boom = new Error("stopping listener failed");
            const second = mock.fn();
            const errors: Error[] = [];
            server.on("stopping", () => {
                throw boom;
            });
            server.on("stopping", second);
            server.on("error", (err) => errors.push(err));
            let hookRan = false;
            server.onShutdown("probe", () => {
                hookRan = true;
            });
            await server.start();
            const port = server.address?.port ?? 0;
            assert.notStrictEqual(port, 0);

            await server.stop();

            assert.strictEqual(second.mock.calls.length, 1, "later listener still called");
            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.deepStrictEqual(errors, [boom]);
            // A failing listener is isolated: the shutdown itself still ran to the end,
            // closing the transport and running the hooks.
            assert.strictEqual(hookRan, true, "shutdown hooks must still run");
            assert.strictEqual(await isPortClosed(port), true, "the port must still be released");
        });

        it("a throwing stop listener does not make stop() reject", async () => {
            const server = make();
            const boom = new Error("stop listener failed");
            const errors: Error[] = [];
            server.on("stop", () => {
                throw boom;
            });
            server.on("error", (err) => errors.push(err));
            await server.start();

            await server.stop();

            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.deepStrictEqual(errors, [boom]);
        });

        it("without an error listener the listener failure is printed, not thrown", async () => {
            const server = make();
            const boom = new Error("stopping listener failed");
            server.on("stopping", () => {
                throw boom;
            });
            await server.start();
            const printed = captureConsole("error");
            try {
                await server.stop();
                assert.strictEqual(server.state, ServerState.STOPPED);
                assert.ok(
                    printed.calls.some((args) => args.includes(boom)),
                    "the exception must be printed",
                );
            } finally {
                printed.restore();
            }
        });

        it("a stopping listener registered with once() is invoked exactly once", async () => {
            const server = make();
            const once = mock.fn();
            server.once("stopping", once);
            await server.start();

            await server.stop();

            assert.strictEqual(once.mock.calls.length, 1);
            // once() semantics: the listener is consumed by the emit, not merely called.
            assert.strictEqual(server.listenerCount("stopping"), 0, "a once() listener must be removed after it fired");
        });

        it("a failed shutdown emits stopping, error, stop in that order and rejects stop()", async () => {
            const server = make();
            const hookError = new Error("hook failed");
            server.onShutdown("failing", async () => {
                throw hookError;
            });
            const events: string[] = [];
            server.on("stopping", () => events.push("stopping"));
            server.on("error", () => events.push("error"));
            server.on("stop", () => events.push("stop"));
            await server.start();

            await assert.rejects(() => server.stop(), hookError);

            assert.deepStrictEqual(events, ["stopping", "error", "stop"]);
            assert.strictEqual(server.state, ServerState.STOPPED);
        });

        it("callers that join a failing shutdown all reject with its error, and a later call resolves", async () => {
            const server = make();
            const hookError = new Error("hook failed");
            server.onShutdown("failing", async () => {
                throw hookError;
            });
            const errors: unknown[] = [];
            server.on("error", (err) => errors.push(err));
            await server.start();

            const first = server.stop();
            const second = server.stop();
            await assert.rejects(() => first, hookError);
            await assert.rejects(() => second, hookError);

            // The server is STOPPED now: the failure was reported once and a repeated stop() has nothing to do.
            await server.stop();
            assert.deepStrictEqual(errors, [hookError]);
        });
    });

    describe("signal-initiated shutdown", () => {
        it("reports a failed shutdown once through the error event", async () => {
            const server = make({ shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
            const hookError = new Error("hook failed");
            server.onShutdown("failing", async () => {
                throw hookError;
            });
            const errors: Error[] = [];
            server.on("error", (err) => errors.push(err));
            await server.start();
            const info = captureConsole("info");
            try {
                const stopped = new Promise<void>((resolve) => server.once("stop", () => resolve()));
                process.emit("SIGWINCH");
                await Promise.race([stopped, tick(1500)]);
                await tick();
            } finally {
                info.restore();
            }

            assert.deepStrictEqual(errors, [hookError]);
        });

        it("a failed shutdown without an error listener is not an unhandled rejection", async () => {
            const server = make({ shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
            server.onShutdown("failing", async () => {
                throw new Error("hook failed");
            });
            await server.start();
            const rejections: unknown[] = [];
            const onRejection = (reason: unknown) => rejections.push(reason);
            process.on("unhandledRejection", onRejection);
            const info = captureConsole("info");
            let stopEmitted = false;
            try {
                const stopped = new Promise<void>((resolve) =>
                    server.once("stop", () => {
                        stopEmitted = true;
                        resolve();
                    }),
                );
                process.emit("SIGWINCH");
                await Promise.race([stopped, tick(1500)]);
                await tick();
            } finally {
                info.restore();
                process.removeListener("unhandledRejection", onRejection);
            }

            // Without proof that the signal really started the shutdown, an empty list
            // of rejections would also be the outcome of a signal that did nothing.
            assert.strictEqual(stopEmitted, true, "the signal must have driven the shutdown to its end");
            assert.strictEqual(server.state, ServerState.STOPPED);
            assert.deepStrictEqual(rejections, []);
        });
    });
});

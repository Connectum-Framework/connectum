/**
 * `createServer({ logger })`: every message the library writes about its own
 * lifecycle goes to the configured logger and nowhere else; without the option
 * the same messages go to `console`, as before the option existed.
 *
 * Each case drives the real server through the situation that produces the
 * message (start, a signal, a failing lifecycle listener, a stuck client at the
 * shutdown timeout, a misconfigured transport, a shutdown hook depending on a
 * name nobody registered) and reads what reached the logger.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ServiceDefinition } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { Server, ServerLogger } from "../../src/types.ts";
import { EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";
import { stubbornClient } from "../helpers/rawClients.ts";

type Level = "info" | "warn" | "error";

interface Recorder {
    readonly logger: ServerLogger;
    /** Every call, in order. */
    readonly calls: Array<{ level: Level; message: string; details: unknown[] }>;
    messages(level: Level): string[];
}

function recorder(): Recorder {
    const calls: Recorder["calls"] = [];
    const record =
        (level: Level) =>
        (message: string, ...details: unknown[]): void => {
            calls.push({ level, message, details });
        };
    return {
        logger: { info: record("info"), warn: record("warn"), error: record("error") },
        calls,
        messages: (level) => calls.filter((call) => call.level === level).map((call) => call.message),
    };
}

/** Replaces the console methods with recorders (`mock.method` is unavailable under Bun). */
function captureConsole(): { readonly calls: Recorder["calls"]; restore(): void } {
    const calls: Recorder["calls"] = [];
    const original = { info: console.info, warn: console.warn, error: console.error };
    for (const level of ["info", "warn", "error"] as const) {
        console[level] = (message: string, ...details: unknown[]): void => {
            calls.push({ level, message: String(message), details });
        };
    }
    return {
        calls,
        restore: () => {
            console.info = original.info;
            console.warn = original.warn;
            console.error = original.error;
        },
    };
}

const echo = (): ServiceDefinition => ({ descriptor: EchoService, register: () => {} });
const bidi = (): ServiceDefinition => ({
    descriptor: StreamingService,
    register(router) {
        router.service(StreamingService, {});
    },
});

describe("createServer({ logger })", () => {
    const servers: Server[] = [];
    let consoleCapture: ReturnType<typeof captureConsole>;

    beforeEach(() => {
        consoleCapture = captureConsole();
    });

    afterEach(async () => {
        consoleCapture.restore();
        for (const server of servers.splice(0)) {
            try {
                if (server.isRunning) await server.stop();
            } catch {
                // cleanup only
            }
        }
    });

    const make = (options: Record<string, unknown> = {}): Server => {
        const server = createServer({ services: [echo()], port: 0, host: "127.0.0.1", ...options });
        servers.push(server);
        return server;
    };

    describe("validation", () => {
        const complete = { info() {}, warn() {}, error() {} };

        for (const [label, bad] of [
            ["a string", "console"],
            ["a number", 5],
            ["null", null],
            ["a function", () => {}],
        ] as const) {
            it(`rejects ${label} with a TypeError naming the option`, () => {
                assert.throws(
                    () => createServer({ services: [echo()], port: 0, logger: bad as never }),
                    (error: unknown) => error instanceof TypeError && /^createServer: logger must be an object with info, warn and error methods/.test(error.message),
                );
            });
        }

        for (const method of ["info", "warn", "error"] as const) {
            it(`rejects a logger whose ${method} is not a function, naming logger.${method}`, () => {
                const logger = { ...complete, [method]: "not a function" };
                assert.throws(
                    () => createServer({ services: [echo()], port: 0, logger: logger as never }),
                    (error: unknown) => error instanceof TypeError && error.message.startsWith(`createServer: logger.${method} must be a function, got string`),
                );
            });

            it(`rejects a logger that lacks ${method} entirely`, () => {
                const { [method]: _omitted, ...rest } = complete;
                assert.throws(
                    () => createServer({ services: [echo()], port: 0, logger: rest as never }),
                    (error: unknown) => error instanceof TypeError && error.message.startsWith(`createServer: logger.${method} must be a function, got undefined`),
                );
            });
        }

        it("accepts a complete logger, console and no logger", () => {
            createServer({ services: [echo()], port: 0, logger: complete });
            createServer({ services: [echo()], port: 0, logger: console });
            createServer({ services: [echo()], port: 0 });
        });
    });

    describe("with a logger", () => {
        it("reports the listening address through info and writes nothing to the console", async () => {
            const log = recorder();
            const server = make({ logger: log.logger });
            await server.start();

            assert.deepStrictEqual(log.messages("info"), [`Server listening 127.0.0.1:${server.address?.port}`]);
            assert.deepStrictEqual(consoleCapture.calls, []);
        });

        it("reports a received signal through info, then stops the server", async () => {
            const log = recorder();
            const server = make({ logger: log.logger, shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
            await server.start();

            process.emit("SIGWINCH");
            while (server.isRunning || server.state === "stopping") await delay(10);

            assert.ok(log.messages("info").includes("Received SIGWINCH, initiating graceful shutdown..."));
            assert.deepStrictEqual(consoleCapture.calls, []);
        });

        it("reports a lifecycle listener that throws with nobody listening to 'error' through error, with the error object", async () => {
            const log = recorder();
            const server = make({ logger: log.logger });
            const boom = new Error("stopping listener failed");
            server.on("stopping", () => {
                throw boom;
            });
            await server.start();
            await server.stop();

            const reported = log.calls.filter((call) => call.level === "error");
            assert.strictEqual(reported.length, 1);
            assert.strictEqual(reported[0]?.message, "Unhandled error in a server lifecycle listener:");
            assert.strictEqual(reported[0]?.details[0], boom);
            assert.deepStrictEqual(
                consoleCapture.calls.filter((call) => call.level === "error"),
                [],
            );
        });

        it("reports an 'error' listener that throws through error", async () => {
            const log = recorder();
            const server = make({ logger: log.logger });
            const listenerBoom = new Error("error listener failed");
            server.on("error", () => {
                throw listenerBoom;
            });
            server.on("stopping", () => {
                throw new Error("stopping listener failed");
            });
            await server.start();
            await server.stop();

            const reported = log.calls.filter((call) => call.level === "error");
            assert.strictEqual(reported.length, 1);
            assert.strictEqual(reported[0]?.message, "An 'error' listener threw:");
            assert.strictEqual(reported[0]?.details[0], listenerBoom);
            assert.deepStrictEqual(consoleCapture.calls, []);
        });

        it("reports an exceeded shutdown timeout through warn", async () => {
            const log = recorder();
            const server = make({ logger: log.logger, shutdown: { timeout: 100 } });
            await server.start();
            const client = await stubbornClient({ port: server.address?.port ?? 0, payload: "GET / HTTP/1.1\r\nHost: loc" });
            try {
                await delay(100);
                await server.stop();
            } finally {
                client.destroy();
            }

            assert.deepStrictEqual(log.messages("warn"), ["Shutdown timeout (100ms) exceeded"]);
            assert.deepStrictEqual(consoleCapture.calls, []);
        });

        it("reports a transport misconfiguration through warn when transportValidation is 'warn'", async () => {
            const log = recorder();
            const server = createServer({ services: [bidi()], port: 0, host: "127.0.0.1", interceptors: [], transportValidation: "warn", logger: log.logger });
            servers.push(server);
            await server.start();

            const warnings = log.messages("warn");
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0] ?? "", /bidi-streaming methods require HTTP\/2/);
            assert.deepStrictEqual(consoleCapture.calls.filter((call) => call.level === "warn"), []);
        });
    });

    describe("without a logger", () => {
        it("writes the same messages to the console", async () => {
            const server = make({ shutdown: { timeout: 100 } });
            server.on("stopping", () => {
                throw new Error("stopping listener failed");
            });
            server.onShutdown("a", ["ghost"], () => {});
            await server.start();
            const client = await stubbornClient({ port: server.address?.port ?? 0, payload: "GET / HTTP/1.1\r\nHost: loc" });
            try {
                await delay(100);
                await server.stop();
            } finally {
                client.destroy();
            }

            const by = (level: Level) => consoleCapture.calls.filter((call) => call.level === level).map((call) => call.message);
            assert.strictEqual(by("info").length, 1);
            assert.match(by("info")[0] ?? "", /^Server listening 127\.0\.0\.1:\d+$/);
            assert.deepStrictEqual(by("error"), ["Unhandled error in a server lifecycle listener:"]);
            assert.strictEqual(by("warn")[0], "Shutdown timeout (100ms) exceeded");
            assert.match(by("warn")[1] ?? "", /^Shutdown hook "a" depends on "ghost"/);
        });
    });

    describe("a logger whose methods throw", () => {
        const throwing: ServerLogger = {
            info() {
                throw new Error("info failed");
            },
            warn() {
                throw new Error("warn failed");
            },
            error() {
                throw new Error("error failed");
            },
        };

        it("does not leave an unhandled rejection when the logger methods are async and reject", async () => {
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown): void => {
                unhandled.push(reason);
            };
            process.on("unhandledRejection", onUnhandled);
            try {
                const rejecting: ServerLogger = {
                    info: async () => {
                        throw new Error("async info failed");
                    },
                    warn: async () => {
                        throw new Error("async warn failed");
                    },
                    error: async () => {
                        throw new Error("async error failed");
                    },
                };
                const server = make({ logger: rejecting });
                server.onShutdown("a", ["ghost"], () => {});
                await server.start();
                await server.stop();
                await delay(50);
            } finally {
                process.removeListener("unhandledRejection", onUnhandled);
            }

            assert.deepStrictEqual(unhandled, []);
        });

        it("does not fail start() and does not skip the shutdown hooks that warn about a missing dependency", async () => {
            const server = make({ logger: throwing, shutdown: { timeout: 100 } });
            const ran: string[] = [];
            server.onShutdown("a", ["ghost"], () => {
                ran.push("a");
            });
            server.on("stopping", () => {
                throw new Error("stopping listener failed");
            });
            await server.start();
            await server.stop();

            assert.deepStrictEqual(ran, ["a"]);
            assert.strictEqual(server.state, "stopped");
        });
    });

    describe("a shutdown hook that depends on a name nobody registered", () => {
        it("still runs, and is reported once through warn with the hook and the missing name", async () => {
            const log = recorder();
            const server = make({ logger: log.logger });
            const ran: string[] = [];
            server.onShutdown("a", ["ghost"], () => {
                ran.push("a");
            });
            await server.start();
            await server.stop();
            await server.stop();

            assert.deepStrictEqual(ran, ["a"]);
            assert.strictEqual(log.messages("warn").length, 1);
            assert.match(log.messages("warn")[0] ?? "", /^Shutdown hook "a" depends on "ghost", but no shutdown hook is registered under that name/);
        });

        it("warns once per missing name, however many hooks name it, and names the hooks", async () => {
            const log = recorder();
            const server = make({ logger: log.logger });
            server.onShutdown("a", ["ghost", "phantom"], () => {});
            server.onShutdown("b", ["ghost"], () => {});
            server.onShutdown("c", ["ghost"], () => {});
            await server.start();
            await server.stop();

            const warnings = log.messages("warn");
            assert.strictEqual(warnings.length, 2);
            assert.match(warnings[0] ?? "", /^Shutdown hooks "a", "b", "c" depend on "ghost"/);
            assert.match(warnings[1] ?? "", /^Shutdown hook "a" depends on "phantom"/);
        });

        it("does not warn for a dependency registered later, before the shutdown", async () => {
            const log = recorder();
            const server = make({ logger: log.logger });
            const order: string[] = [];
            server.onShutdown("api", ["db"], () => {
                order.push("api");
            });
            await server.start();
            server.onShutdown("db", async () => {
                await delay(20);
                order.push("db");
            });
            await server.stop();

            assert.deepStrictEqual(order, ["db", "api"]);
            assert.deepStrictEqual(log.messages("warn"), []);
        });
    });
});

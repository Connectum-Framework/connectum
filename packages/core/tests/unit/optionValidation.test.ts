/**
 * Construction-time validation of numeric and boolean options that would
 * otherwise misbehave silently: `shutdown.timeout`, `shutdown.forceCloseOnTimeout`
 * and a service's own `readMaxBytes`.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { defineLazyService, defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { HTTP2_FRAME_SETTINGS, HTTP2_PREFACE, settlesWithin, stubbornClient } from "../helpers/rawClients.ts";

const MAX_TIMER_MS = 2_147_483_647;
const MAX_READ_MAX_BYTES = 4_294_967_295;

const serverWith = (shutdown: Record<string, unknown>) => () => createServer({ services: [], shutdown: shutdown as never });

describe("shutdown.timeout", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, MAX_TIMER_MS + 1]) {
        it(`rejects ${String(bad)} with a RangeError naming the option`, () => {
            assert.throws(serverWith({ timeout: bad }), (err: unknown) => err instanceof RangeError && /shutdown\.timeout/.test(err.message) && err.message.includes(String(bad)));
        });
    }

    for (const bad of ["30", null, true, {}]) {
        it(`rejects the non-number ${JSON.stringify(bad)} with a TypeError naming the option`, () => {
            assert.throws(serverWith({ timeout: bad }), (err: unknown) => err instanceof TypeError && /shutdown\.timeout/.test(err.message));
        });
    }

    // The accepted bounds are observed by what stop() arms, in "effect on server.stop()"
    // below; creation alone would not tell a stored value from a discarded one.
    for (const good of [0, 1, 30_000, MAX_TIMER_MS]) {
        it(`accepts ${good} at creation`, () => {
            assert.doesNotThrow(serverWith({ timeout: good }));
        });
    }

    describe("effect on server.stop()", () => {
        /** Delays handed to `setTimeout` while `fn` runs; patched by hand because `mock.method` does not exist under Bun. */
        async function recordTimerDelays(fn: () => Promise<void>): Promise<number[]> {
            const delays: number[] = [];
            const original = globalThis.setTimeout;
            globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
                delays.push(delay ?? 0);
                return original(handler as () => void, delay, ...args);
            }) as typeof globalThis.setTimeout;
            try {
                await fn();
            } finally {
                globalThis.setTimeout = original;
            }
            return delays;
        }

        for (const [name, shutdown] of [
            ["no shutdown option", undefined],
            ["an empty shutdown option", {}],
            ["an undefined timeout", { timeout: undefined }],
        ] as const) {
            it(`waits for the documented 30000 ms graceful phase with ${name}`, async () => {
                const server = createServer({ services: [], port: 0, host: "127.0.0.1", ...(shutdown === undefined ? {} : { shutdown: shutdown as never }) });
                await server.start();

                const delays = await recordTimerDelays(() => server.stop());

                assert.ok(delays.includes(30_000), `no 30000 ms timer was armed, saw ${JSON.stringify(delays)}`);
            });
        }

        // 12 345 is an arbitrary value; 1 and the largest timer delay are the accepted bounds.
        for (const configured of [12_345, 1, MAX_TIMER_MS]) {
            it(`a configured timeout of ${configured} ms replaces the default graceful phase`, async () => {
                const server = createServer({ services: [], port: 0, host: "127.0.0.1", shutdown: { timeout: configured } });
                await server.start();

                const delays = await recordTimerDelays(() => server.stop());

                assert.ok(delays.includes(configured), `the configured timeout was not armed, saw ${JSON.stringify(delays)}`);
                assert.ok(!delays.includes(30_000), "the default must not be armed next to the configured value");
            });
        }

        it("0 means the graceful phase is not waited for, even while a client holds its connection open", async () => {
            const server = createServer({ services: [], port: 0, host: "127.0.0.1", allowHTTP1: false, shutdown: { timeout: 0, forceCloseOnTimeout: false } });
            await server.start();
            let settings: () => void = () => {};
            const settingsSeen = new Promise<void>((resolve) => {
                settings = resolve;
            });
            const client = await stubbornClient({
                port: server.address?.port ?? 0,
                payload: HTTP2_PREFACE,
                onHttp2Frame: (type) => {
                    if (type === HTTP2_FRAME_SETTINGS) settings();
                },
            });
            try {
                await settingsSeen;

                const stopped = server.stop();

                assert.strictEqual(await settlesWithin(stopped, 2000), true, "stop() waited for a client that never leaves although the timeout is 0");
            } finally {
                client.destroy();
            }
        });
    });
});

describe("shutdown.forceCloseOnTimeout", () => {
    for (const bad of ["false", 0, 1, null, {}]) {
        it(`rejects ${JSON.stringify(bad)} with a TypeError naming the option`, () => {
            assert.throws(serverWith({ forceCloseOnTimeout: bad }), (err: unknown) => err instanceof TypeError && /shutdown\.forceCloseOnTimeout/.test(err.message));
        });
    }

    for (const good of [true, false, undefined]) {
        it(`accepts ${String(good)}`, () => {
            assert.doesNotThrow(serverWith({ forceCloseOnTimeout: good }));
        });
    }
});

describe("service-level readMaxBytes", () => {
    const factories = {
        defineService: (readMaxBytes: unknown) => () => defineService(EchoService, {} as never, { readMaxBytes } as never),
        defineLazyService: (readMaxBytes: unknown) => () => defineLazyService(EchoService, () => ({}) as never, { readMaxBytes } as never),
    };

    for (const [name, make] of Object.entries(factories)) {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, MAX_READ_MAX_BYTES + 1]) {
            it(`${name} rejects ${String(bad)} with a RangeError naming readMaxBytes`, () => {
                assert.throws(make(bad), (err: unknown) => err instanceof RangeError && /readMaxBytes/.test(err.message) && err.message.includes(String(bad)));
            });
        }

        it(`${name} rejects a non-number with a TypeError naming readMaxBytes`, () => {
            assert.throws(make("1024"), (err: unknown) => err instanceof TypeError && /readMaxBytes/.test(err.message));
        });

        for (const good of [1, 1024, MAX_READ_MAX_BYTES, undefined]) {
            it(`${name} accepts ${String(good)}`, () => {
                assert.doesNotThrow(make(good));
            });
        }
    }
});

describe("caller prefix in the validation message", () => {
    // A rejected option is reported in one form for every entry point: the name of
    // the function the user called, a colon, then the option. Without the prefix a
    // user who configures several services cannot tell which call to fix.
    const rejections: Record<string, { call: () => unknown; option: string }> = {
        createServer: { call: () => createServer({ services: [], readMaxBytes: 0 }), option: "readMaxBytes" },
        "createServer (shutdown.timeout)": { call: serverWith({ timeout: -1 }), option: "shutdown.timeout" },
        "createServer (shutdown.forceCloseOnTimeout)": { call: serverWith({ forceCloseOnTimeout: "no" }), option: "shutdown.forceCloseOnTimeout" },
        defineService: { call: () => defineService(EchoService, {} as never, { readMaxBytes: 0 }), option: "readMaxBytes" },
        defineLazyService: { call: () => defineLazyService(EchoService, () => ({}) as never, { readMaxBytes: 0 }), option: "readMaxBytes" },
    };

    for (const [name, { call, option }] of Object.entries(rejections)) {
        const caller = name.split(" ")[0] as string;
        it(`${name} starts the message with its own function name`, () => {
            assert.throws(call, (err: unknown) => err instanceof Error && err.message.startsWith(`${caller}: ${option}`), "the message must read '<caller>: <option> ...'");
        });
    }
});

const serverWithOptions = (options: Record<string, unknown>) => () => createServer({ services: [], ...options } as never);

describe("port", () => {
    for (const bad of [-1, 65536, 70_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`rejects the number ${String(bad)} with a RangeError naming the option`, () => {
            assert.throws(serverWithOptions({ port: bad }), (err: unknown) => err instanceof RangeError && /createServer: port\b/.test(err.message) && err.message.includes(String(bad)));
        });
    }

    // A string port is not coerced: Node reads a non-numeric one as a Unix socket path.
    for (const bad of ["abc", "5000", "", null, true, {}]) {
        it(`rejects the non-number ${JSON.stringify(bad)} with a TypeError naming the option`, () => {
            assert.throws(serverWithOptions({ port: bad }), (err: unknown) => err instanceof TypeError && /createServer: port\b/.test(err.message));
        });
    }

    for (const good of [0, 1, 5000, 65_535]) {
        it(`accepts ${good} at creation`, () => {
            assert.doesNotThrow(serverWithOptions({ port: good }));
        });
    }

    it("a valid port is the port the server listens on", async () => {
        const probe = createServer({ services: [], port: 0, host: "127.0.0.1" });
        await probe.start();
        const free = probe.address?.port ?? 0;
        await probe.stop();

        const server = createServer({ services: [], port: free, host: "127.0.0.1" });
        await server.start();
        try {
            assert.strictEqual(server.address?.port, free);
        } finally {
            await server.stop();
        }
    });
});

describe("host", () => {
    it("rejects the empty string with a RangeError naming the option, because it would bind every interface", () => {
        assert.throws(serverWithOptions({ host: "" }), (err: unknown) => err instanceof RangeError && /createServer: host\b/.test(err.message));
    });

    for (const bad of [123, null, true, {}, ["127.0.0.1"]]) {
        it(`rejects the non-string ${JSON.stringify(bad)} with a TypeError naming the option`, () => {
            assert.throws(serverWithOptions({ host: bad }), (err: unknown) => err instanceof TypeError && /createServer: host\b/.test(err.message));
        });
    }

    it("a valid host is the address the server binds", async () => {
        const server = createServer({ services: [], port: 0, host: "127.0.0.1" });
        await server.start();
        try {
            assert.strictEqual(server.address?.address, "127.0.0.1");
        } finally {
            await server.stop();
        }
    });
});

describe("shutdown.autoShutdown", () => {
    for (const bad of ["yes", "false", 1, 0, null, {}]) {
        it(`rejects ${JSON.stringify(bad)} with a TypeError naming the option`, () => {
            assert.throws(serverWith({ autoShutdown: bad }), (err: unknown) => err instanceof TypeError && /shutdown\.autoShutdown/.test(err.message));
        });
    }

    for (const good of [true, false, undefined]) {
        it(`accepts ${String(good)}`, () => {
            assert.doesNotThrow(serverWith({ autoShutdown: good }));
        });
    }
});

describe("shutdown.signals", () => {
    for (const bad of ["SIGTERM", null, 15, {}]) {
        it(`rejects the non-array ${JSON.stringify(bad)} with a TypeError naming the option`, () => {
            assert.throws(serverWith({ autoShutdown: true, signals: bad }), (err: unknown) => err instanceof TypeError && /shutdown\.signals/.test(err.message));
        });
    }

    it("rejects an empty list: it would install no handler and the default action would end the process", () => {
        assert.throws(serverWith({ autoShutdown: true, signals: [] }), (err: unknown) => err instanceof RangeError && /shutdown\.signals/.test(err.message));
    });

    it("rejects an unknown signal name and names it", () => {
        assert.throws(serverWith({ autoShutdown: true, signals: ["SIGTERM", "SIGFOO"] }), (err: unknown) => err instanceof RangeError && /shutdown\.signals/.test(err.message) && err.message.includes("SIGFOO"));
    });

    it("rejects a lowercase name: the signal table is case-sensitive", () => {
        assert.throws(serverWith({ signals: ["sigterm"] }), (err: unknown) => err instanceof RangeError && err.message.includes("sigterm"));
    });

    for (const unhandleable of ["SIGKILL", "SIGSTOP"]) {
        it(`rejects ${unhandleable}, which a process cannot handle`, () => {
            assert.throws(serverWith({ autoShutdown: true, signals: [unhandleable] }), (err: unknown) => err instanceof RangeError && err.message.includes(unhandleable));
        });
    }

    it("rejects a non-string element", () => {
        assert.throws(serverWith({ signals: [15] }), (err: unknown) => err instanceof TypeError && /shutdown\.signals/.test(err.message));
    });

    it("is checked even when autoShutdown is off, so a typo does not wait for a later switch", () => {
        assert.throws(serverWith({ autoShutdown: false, signals: ["SIGFOO"] }), RangeError);
    });

    for (const good of [["SIGTERM"], ["SIGTERM", "SIGINT"], ["SIGHUP", "SIGUSR2"], undefined]) {
        it(`accepts ${JSON.stringify(good)}`, () => {
            assert.doesNotThrow(serverWith({ autoShutdown: true, signals: good }));
        });
    }
});

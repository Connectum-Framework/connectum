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

    for (const good of [0, 1, 30_000, MAX_TIMER_MS]) {
        it(`accepts ${good}`, () => {
            assert.doesNotThrow(serverWith({ timeout: good }));
        });
    }

    it("accepts an unset timeout and an absent shutdown option", () => {
        assert.doesNotThrow(serverWith({}));
        assert.doesNotThrow(serverWith({ timeout: undefined }));
        assert.doesNotThrow(() => createServer({ services: [] }));
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

    it("accepts a service without options", () => {
        assert.doesNotThrow(() => defineService(EchoService, {} as never));
    });
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

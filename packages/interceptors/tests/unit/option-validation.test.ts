/**
 * Non-numeric option validation of the interceptor factories
 *
 * A wrong option type used to be accepted at creation and show up later: as an
 * `Internal` error on the first failing call, as a missing log line, as a flag read
 * as true because it was a non-empty string, or as a raw `TypeError` that does not
 * name the factory. The numeric options are covered next to each interceptor.
 *
 * @module option-validation.test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { createBulkheadInterceptor } from "../../src/bulkhead.ts";
import { createCircuitBreakerInterceptor } from "../../src/circuit-breaker.ts";
import { createFallbackInterceptor } from "../../src/fallback.ts";
import { createLoggerInterceptor } from "../../src/logger.ts";
import { createMethodFilterInterceptor } from "../../src/method-filter.ts";
import { createRetryInterceptor } from "../../src/retry.ts";
import { createSerializerInterceptor } from "../../src/serializer.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

type Factory = (options: never) => unknown;

const factories: ReadonlyArray<readonly [string, Factory]> = [
    ["createTimeoutInterceptor", createTimeoutInterceptor as Factory],
    ["createBulkheadInterceptor", createBulkheadInterceptor as Factory],
    ["createCircuitBreakerInterceptor", createCircuitBreakerInterceptor as Factory],
    ["createRetryInterceptor", createRetryInterceptor as Factory],
    ["createLoggerInterceptor", createLoggerInterceptor as Factory],
    ["createSerializerInterceptor", createSerializerInterceptor as Factory],
    ["createFallbackInterceptor", createFallbackInterceptor as Factory],
    ["createMethodFilterInterceptor", ((options: never) => createMethodFilterInterceptor(options)) as Factory],
];

describe("the options argument of each factory", () => {
    for (const [name, factory] of factories) {
        for (const [label, value, got] of [
            ["null", null, "null"],
            ["a string", "debug", '"debug"'],
            ["a number", 5, "5"],
            ["an array", [], "an array"],
        ] as const) {
            it(`${name} refuses ${label} with a TypeError that names the factory`, () => {
                assert.throws(
                    () => factory(value as never),
                    (err: unknown) => err instanceof TypeError && err.message.startsWith(`${name}: `) && err.message.includes(`must be an object, got ${got}`),
                );
            });
        }
    }

    it("createFallbackInterceptor refuses a call without arguments", () => {
        assert.throws(
            () => (createFallbackInterceptor as unknown as () => unknown)(),
            (err: unknown) => err instanceof TypeError && err.message === "createFallbackInterceptor: options must be an object, got undefined",
        );
    });

    it("the factories with defaults still accept no argument and an empty object", () => {
        for (const [name, factory] of factories) {
            if (name === "createFallbackInterceptor" || name === "createMethodFilterInterceptor") continue;
            assert.strictEqual(typeof (factory as () => unknown)(), "function", name);
            assert.strictEqual(typeof factory({} as never), "function", name);
        }
    });
});

describe("boolean options", () => {
    const handler = () => ({});
    const cases: ReadonlyArray<readonly [string, string, (value: unknown) => unknown]> = [
        ["createTimeoutInterceptor", "skipStreaming", (skipStreaming) => createTimeoutInterceptor({ skipStreaming } as never)],
        ["createBulkheadInterceptor", "skipStreaming", (skipStreaming) => createBulkheadInterceptor({ skipStreaming } as never)],
        ["createCircuitBreakerInterceptor", "skipStreaming", (skipStreaming) => createCircuitBreakerInterceptor({ skipStreaming } as never)],
        ["createRetryInterceptor", "skipStreaming", (skipStreaming) => createRetryInterceptor({ skipStreaming } as never)],
        ["createFallbackInterceptor", "skipStreaming", (skipStreaming) => createFallbackInterceptor({ handler, skipStreaming } as never)],
        ["createLoggerInterceptor", "skipHealthCheck", (skipHealthCheck) => createLoggerInterceptor({ skipHealthCheck } as never)],
        ["createLoggerInterceptor", "includeTransport", (includeTransport) => createLoggerInterceptor({ includeTransport } as never)],
        ["createLoggerInterceptor", "includeBodies", (includeBodies) => createLoggerInterceptor({ includeBodies } as never)],
        ["createSerializerInterceptor", "skipGrpcServices", (skipGrpcServices) => createSerializerInterceptor({ skipGrpcServices } as never)],
        ["createSerializerInterceptor", "alwaysEmitImplicit", (alwaysEmitImplicit) => createSerializerInterceptor({ alwaysEmitImplicit } as never)],
        ["createSerializerInterceptor", "ignoreUnknownFields", (ignoreUnknownFields) => createSerializerInterceptor({ ignoreUnknownFields } as never)],
    ];

    for (const [caller, option, make] of cases) {
        for (const [label, value, got] of [
            ["the string no", "no", '"no"'],
            ["the string yes", "yes", '"yes"'],
            ["the number 1", 1, "1"],
            ["the number 0", 0, "0"],
            ["null", null, "null"],
        ] as const) {
            it(`${caller} refuses ${label} for ${option}, which is not a boolean`, () => {
                assert.throws(
                    () => make(value),
                    (err: unknown) => err instanceof TypeError && err.message === `${caller}: ${option} must be true or false, got ${got}`,
                );
            });
        }

        it(`${caller} accepts true, false and undefined for ${option}`, () => {
            for (const value of [true, false, undefined]) {
                assert.strictEqual(typeof make(value), "function");
            }
        });
    }
});

describe("function options", () => {
    for (const [label, value, got] of [
        ["a string", "x", '"x"'],
        ["null", null, "null"],
        ["an object", {}, "an object"],
        ["a number", 3, "3"],
    ] as const) {
        it(`createCircuitBreakerInterceptor refuses ${label} for failurePredicate`, () => {
            assert.throws(
                () => createCircuitBreakerInterceptor({ failurePredicate: value } as never),
                (err: unknown) => err instanceof TypeError && err.message === `createCircuitBreakerInterceptor: failurePredicate must be a function, got ${got}`,
            );
        });

        it(`createLoggerInterceptor refuses ${label} for logger`, () => {
            assert.throws(
                () => createLoggerInterceptor({ logger: value } as never),
                (err: unknown) => err instanceof TypeError && err.message === `createLoggerInterceptor: logger must be a function, got ${got}`,
            );
        });
    }

    it("a function and undefined are accepted for both", () => {
        assert.strictEqual(typeof createCircuitBreakerInterceptor({ failurePredicate: () => true }), "function");
        assert.strictEqual(typeof createCircuitBreakerInterceptor({ failurePredicate: undefined } as never), "function");
        assert.strictEqual(typeof createLoggerInterceptor({ logger: () => {} }), "function");
        assert.strictEqual(typeof createLoggerInterceptor({ logger: undefined } as never), "function");
    });
});

describe("the logger level", () => {
    it("refuses a level that is not a log level with a RangeError listing the accepted ones", () => {
        assert.throws(
            () => createLoggerInterceptor({ level: "bogus" } as never),
            (err: unknown) => err instanceof RangeError && err.message === 'createLoggerInterceptor: level must be one of "debug", "info", "warn", "error", got "bogus"',
        );
    });

    it("refuses a level of another type with a TypeError", () => {
        for (const level of [null, 1, {}, true]) {
            assert.throws(
                () => createLoggerInterceptor({ level } as never),
                (err: unknown) => err instanceof TypeError && err.message.startsWith("createLoggerInterceptor: level must be one of "),
            );
        }
    });

    it("refuses a level that exists on console but is not a log level", () => {
        // console.log and console.table exist, but are not the four levels the interceptor documents
        for (const level of ["log", "table", "trace"]) {
            assert.throws(() => createLoggerInterceptor({ level } as never), RangeError);
        }
    });

    it("accepts the four levels", () => {
        for (const level of ["debug", "info", "warn", "error"] as const) {
            assert.strictEqual(typeof createLoggerInterceptor({ level }), "function");
        }
    });
});

describe("retryableCodes", () => {
    for (const [label, value, got] of [
        ["null", null, "null"],
        ["a string", "14", '"14"'],
        ["a bare number", 14, "14"],
        ["an object", {}, "an object"],
    ] as const) {
        it(`refuses ${label} with a TypeError that names the option`, () => {
            assert.throws(
                () => createRetryInterceptor({ retryableCodes: value } as never),
                (err: unknown) => err instanceof TypeError && err.message === `createRetryInterceptor: retryableCodes must be an array of Connect codes, got ${got}`,
            );
        });
    }

    it("refuses an entry that is not a number, naming its position", () => {
        assert.throws(
            () => createRetryInterceptor({ retryableCodes: [Code.Unavailable, "14"] } as never),
            (err: unknown) => err instanceof TypeError && err.message === 'createRetryInterceptor: entry 1 of retryableCodes must be a Connect code, got "14"',
        );
        assert.throws(() => createRetryInterceptor({ retryableCodes: [Code.Unavailable, , Code.Internal] } as never), TypeError);
    });

    it("refuses a number that is not a Connect code with a RangeError", () => {
        for (const entry of [0, 17, 99, -1, 1.5, Number.NaN]) {
            assert.throws(
                () => createRetryInterceptor({ retryableCodes: [entry] } as never),
                (err: unknown) => err instanceof RangeError && err.message.startsWith("createRetryInterceptor: entry 0 of retryableCodes must be a Connect code from 1 to 16"),
            );
        }
    });

    it("accepts an empty list, every Connect code and the default", () => {
        assert.strictEqual(typeof createRetryInterceptor({ retryableCodes: [] }), "function");
        const everyCode = Array.from({ length: 16 }, (_, index) => index + 1) as Code[];
        assert.strictEqual(typeof createRetryInterceptor({ retryableCodes: everyCode }), "function");
        assert.strictEqual(typeof createRetryInterceptor({ retryableCodes: undefined } as never), "function");
    });
});

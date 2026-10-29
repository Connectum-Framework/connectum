/**
 * Options the adapter cannot honor are rejected when it is created, with an
 * error that names the option. Nothing here needs a broker: the factory must
 * refuse before any connection is attempted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AmqpAdapterOptions } from "../../src/index.ts";
import { AmqpAdapter, AmqpTopologyMode } from "../../src/index.ts";

const URL = "amqp://127.0.0.1:1";

/** Build the options without the compiler's help: the point is the runtime check for JavaScript callers. */
function create(extra: Record<string, unknown>): void {
    AmqpAdapter({ url: URL, ...extra } as AmqpAdapterOptions);
}

describe("topologyMode", () => {
    it("accepts exactly the three documented modes, and an unset option", () => {
        for (const mode of Object.values(AmqpTopologyMode)) {
            assert.doesNotThrow(() => create({ topologyMode: mode }), mode);
        }
        assert.doesNotThrow(() => create({}));
        assert.doesNotThrow(() => create({ topologyMode: undefined }));
    });

    for (const bad of ["CHECK", "Check", "SKIP", "Assert", "bogus", "", 42, null, true, {}, ["check"]]) {
        it(`rejects ${JSON.stringify(bad)} instead of acting as assert, naming the option and the allowed values`, () => {
            assert.throws(
                () => create({ topologyMode: bad }),
                (error: unknown) => {
                    assert.ok(error instanceof TypeError, `expected TypeError, got ${String(error)}`);
                    assert.match(error.message, /topologyMode/);
                    assert.match(error.message, /"assert", "check", "skip"/);
                    return true;
                },
            );
        });
    }
});

/** `create` with a nested option, e.g. `nested("consumerOptions", { prefetch: -1 })`. */
function nested(key: string, value: unknown): void {
    create({ [key]: value });
}

function assertRejects(attempt: () => void, errorClass: typeof TypeError | typeof RangeError, optionName: string): void {
    assert.throws(attempt, (error: unknown) => {
        assert.ok(error instanceof errorClass, `expected ${errorClass.name}, got ${String(error)}`);
        assert.ok(error.message.startsWith("AmqpAdapter: "), error.message);
        assert.ok(error.message.includes(optionName), `the message must name ${optionName}: ${error.message}`);
        return true;
    });
}

describe("the options object", () => {
    for (const bad of [undefined, null, "amqp://x", 5, [], true]) {
        it(`${JSON.stringify(bad) ?? "undefined"} is a TypeError that says what is expected, not an internal 'Cannot read properties'`, () => {
            assertRejects(() => AmqpAdapter(bad as unknown as AmqpAdapterOptions), TypeError, "options");
        });
    }
});

describe("exchangeType", () => {
    it("accepts the four types and an unset option", () => {
        for (const type of ["topic", "direct", "fanout", "headers"]) {
            assert.doesNotThrow(() => create({ exchangeType: type }), type);
        }
        assert.doesNotThrow(() => create({ exchangeType: undefined }));
    });

    for (const bad of ["TOPIC", "bogus", "", 1, null, {}]) {
        it(`rejects ${JSON.stringify(bad)} at creation, before connect() can fail on it`, () => {
            assertRejects(() => create({ exchangeType: bad }), TypeError, "exchangeType");
        });
    }
});

describe("consumerOptions.prefetch", () => {
    it("accepts 0 (no limit), the default range and the 16-bit maximum", () => {
        for (const prefetch of [0, 1, 10, 65_535]) {
            assert.doesNotThrow(() => nested("consumerOptions", { prefetch }), String(prefetch));
        }
        assert.doesNotThrow(() => nested("consumerOptions", {}));
    });

    for (const bad of [Number.NaN, -1, 70_000, 65_536, 1.5, Number.POSITIVE_INFINITY]) {
        it(`rejects ${bad} with a RangeError at creation instead of failing in subscribe()`, () => {
            assertRejects(() => nested("consumerOptions", { prefetch: bad }), RangeError, "consumerOptions.prefetch");
        });
    }

    it('rejects the string "5" and a non-object consumerOptions with a TypeError', () => {
        assertRejects(() => nested("consumerOptions", { prefetch: "5" }), TypeError, "consumerOptions.prefetch");
        assertRejects(() => nested("consumerOptions", "x"), TypeError, "consumerOptions");
    });
});

describe("queueOptions", () => {
    it("accepts non-negative integers", () => {
        assert.doesNotThrow(() => nested("queueOptions", { messageTtl: 0, maxLength: 0 }));
        assert.doesNotThrow(() => nested("queueOptions", { messageTtl: 60_000, maxLength: 1000 }));
    });

    for (const [option, bad] of [
        ["messageTtl", -1],
        ["messageTtl", 1.5],
        ["messageTtl", Number.NaN],
        ["maxLength", -1],
        ["maxLength", 2.5],
        ["maxLength", Number.POSITIVE_INFINITY],
    ] as const) {
        it(`rejects ${option}: ${bad} with a RangeError`, () => {
            assertRejects(() => nested("queueOptions", { [option]: bad }), RangeError, `queueOptions.${option}`);
        });
    }

    it("rejects a string value with a TypeError", () => {
        assertRejects(() => nested("queueOptions", { messageTtl: "60000" }), TypeError, "queueOptions.messageTtl");
    });
});

describe("jitter", () => {
    it("accepts 0, a fraction and 1", () => {
        for (const jitter of [0, 0.2, 1]) {
            assert.doesNotThrow(() => nested("recovery", { jitter }), String(jitter));
            assert.doesNotThrow(() => nested("publishRetry", { jitter }), String(jitter));
        }
    });

    for (const bad of [5, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`rejects ${bad} in recovery and in publishRetry with a RangeError`, () => {
            assertRejects(() => nested("recovery", { jitter: bad }), RangeError, "recovery.jitter");
            assertRejects(() => nested("publishRetry", { jitter: bad }), RangeError, "publishRetry.jitter");
        });
    }

    it("rejects a string with a TypeError", () => {
        assertRejects(() => nested("recovery", { jitter: "0.2" }), TypeError, "recovery.jitter");
    });
});

describe("recovery and publishRetry shapes", () => {
    it("accept a boolean, an object and an unset option", () => {
        for (const value of [true, false, {}, undefined]) {
            assert.doesNotThrow(() => nested("recovery", value));
            assert.doesNotThrow(() => nested("publishRetry", value));
        }
    });

    it("reject null, a string and a number instead of reading properties of them", () => {
        for (const bad of [null, "yes", 3]) {
            assertRejects(() => nested("recovery", bad), TypeError, "recovery");
            assertRejects(() => nested("publishRetry", bad), TypeError, "publishRetry");
        }
    });

    it("publishRetry.maxRetries must be a number: the documented normalization of a number (NaN, fractions, negatives, Infinity) is untouched", () => {
        for (const ok of [0, 3, 2.5, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
            assert.doesNotThrow(() => nested("publishRetry", { maxRetries: ok }), String(ok));
        }
        assertRejects(() => nested("publishRetry", { maxRetries: "x" }), TypeError, "publishRetry.maxRetries");
    });

    it("keeps the documented tolerances of the other budget options", () => {
        assert.doesNotThrow(() => create({ publishTimeoutMs: Number.NaN }));
        assert.doesNotThrow(() => nested("recovery", { initialConnectMaxRetries: Number.NaN, maxRetries: -1 }));
    });
});

describe("serialization", () => {
    it("accepts functions and a string content type", () => {
        assert.doesNotThrow(() => nested("serialization", { encode: (b: Uint8Array) => b, decode: (b: Uint8Array) => b, contentType: "application/json" }));
    });

    it("rejects an encode or decode that is not a function, and a content type that is not a string", () => {
        assertRejects(() => nested("serialization", { encode: "x" }), TypeError, "serialization.encode");
        assertRejects(() => nested("serialization", { decode: {} }), TypeError, "serialization.decode");
        assertRejects(() => nested("serialization", { contentType: 5 }), TypeError, "serialization.contentType");
        assertRejects(() => nested("serialization", "json"), TypeError, "serialization");
    });
});

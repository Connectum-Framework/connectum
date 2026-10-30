/**
 * Construction-time validation of the adapter options that used to be accepted silently and to
 * fail later, at `connect()` or `subscribe()`, with an error that did not name the option.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import type { KafkaAdapterOptions } from "../../src/types.ts";

const base = { brokers: ["b1:9092"] };

/** Builds the adapter from options a JavaScript caller (or a cast) can still pass. */
const build = (options: unknown) => () => KafkaAdapter(options as KafkaAdapterOptions);

describe("KafkaAdapter option validation", () => {
    it("names the missing options object instead of failing inside the removed-option check", () => {
        for (const bad of [undefined, null, "localhost:9092", 42]) {
            assert.throws(build(bad), (err: unknown) => err instanceof TypeError && /^KafkaAdapter: options must be an object/.test(err.message) && !err.message.includes("'in' operator"), String(bad));
        }
    });

    describe("brokers", () => {
        it("rejects a missing or non-array value with a TypeError naming the option", () => {
            for (const brokers of [undefined, "localhost:9092", { 0: "b:1" }, null, 9092]) {
                assert.throws(build({ brokers }), (err: unknown) => err instanceof TypeError && err.message.includes("brokers must be an array of broker addresses"), String(brokers));
            }
        });

        it("rejects an empty list with a RangeError", () => {
            assert.throws(build({ brokers: [] }), (err: unknown) => err instanceof RangeError && err.message.includes("brokers must contain at least one"));
        });

        it("rejects an entry that is not a non-empty string and names its position", () => {
            for (const entry of ["", "   ", 9092, null, undefined]) {
                assert.throws(build({ brokers: ["ok:1", entry] }), (err: unknown) => err instanceof TypeError && err.message.includes("brokers[1]"), String(entry));
            }
        });

        it("accepts one or several addresses", () => {
            assert.doesNotThrow(build({ brokers: ["a:9092"] }));
            assert.doesNotThrow(build({ brokers: ["a:9092", "b:9092"] }));
        });
    });

    describe("clientId", () => {
        it("rejects an empty or non-string identifier", () => {
            for (const clientId of ["", "  ", 7, null]) {
                assert.throws(build({ ...base, clientId }), (err: unknown) => err instanceof TypeError && err.message.includes("clientId must be a non-empty string"), String(clientId));
            }
        });

        it("accepts a name and an omitted value", () => {
            assert.doesNotThrow(build({ ...base, clientId: "svc" }));
            assert.doesNotThrow(build(base));
            assert.doesNotThrow(build({ ...base, clientId: undefined }));
        });
    });

    describe("consumerOptions.sessionTimeout", () => {
        it("rejects a value that is not a finite number above the 3000 ms heartbeat interval", () => {
            for (const sessionTimeout of [-5, 0, 3_000, 2_999, Number.NaN, Number.POSITIVE_INFINITY, "6000", null]) {
                assert.throws(build({ ...base, consumerOptions: { sessionTimeout } }), (err: unknown) => err instanceof RangeError && err.message.includes("consumerOptions.sessionTimeout"), String(sessionTimeout));
            }
        });

        it("accepts the values the integration suites use", () => {
            for (const sessionTimeout of [3_001, 4_000, 6_000, 30_000, 10_000_000]) {
                assert.doesNotThrow(build({ ...base, consumerOptions: { sessionTimeout } }), String(sessionTimeout));
            }
        });
    });

    describe("retry", () => {
        it("rejects a retry that is not an object", () => {
            for (const retry of ["5", 5, null, []]) {
                assert.throws(build({ ...base, retry }), (err: unknown) => err instanceof TypeError && err.message.includes("retry must be an object"), String(retry));
            }
        });

        it("rejects a negative or fractional retries and any non-integer", () => {
            for (const retries of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
                assert.throws(build({ ...base, retry: { retries } }), (err: unknown) => err instanceof RangeError && err.message.includes("retry.retries"), String(retries));
            }
        });

        it("rejects a negative or non-finite delay, factor and multiplier", () => {
            for (const key of ["maxRetryTime", "initialRetryTime", "factor", "multiplier"] as const) {
                for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "300", null]) {
                    assert.throws(build({ ...base, retry: { [key]: value } }), (err: unknown) => err instanceof RangeError && err.message.includes(`retry.${key}`), `${key}=${String(value)}`);
                }
            }
        });

        it("accepts zero retries and the documented shape", () => {
            assert.doesNotThrow(build({ ...base, retry: { retries: 0 } }));
            assert.doesNotThrow(build({ ...base, retry: { retries: 8, initialRetryTime: 100, maxRetryTime: 30_000, factor: 0.2, multiplier: 2 } }));
        });
    });

    describe("sasl", () => {
        it("rejects a mechanism the adapter does not know and lists the accepted ones", () => {
            for (const mechanism of ["kerberos", "PLAIN", "", undefined, 1]) {
                assert.throws(
                    build({ ...base, sasl: { mechanism, username: "u", password: "p" } }),
                    (err: unknown) => err instanceof RangeError && err.message.includes("sasl.mechanism must be one of plain, scram-sha-256, scram-sha-512, oauthbearer, aws"),
                    String(mechanism),
                );
            }
        });

        it("rejects a sasl value that is not an object", () => {
            for (const sasl of ["plain", true, null]) {
                assert.throws(build({ ...base, sasl }), (err: unknown) => err instanceof TypeError && err.message.includes("sasl must be an object"), String(sasl));
            }
        });

        it("accepts every documented mechanism", () => {
            for (const mechanism of ["plain", "scram-sha-256", "scram-sha-512"]) {
                assert.doesNotThrow(build({ ...base, sasl: { mechanism, username: "u", password: "p" } }), mechanism);
            }
            assert.doesNotThrow(build({ ...base, sasl: { mechanism: "oauthbearer", oauthBearerProvider: async () => ({ value: "t" }) } }));
            assert.doesNotThrow(build({ ...base, sasl: { mechanism: "aws", authorizationIdentity: "a", accessKeyId: "k", secretAccessKey: "s" } }));
        });
    });
});

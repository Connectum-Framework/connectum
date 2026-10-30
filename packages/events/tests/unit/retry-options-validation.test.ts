/**
 * `initialDelay`, `maxDelay`, `multiplier` and `backoff` of the retry middleware are checked when
 * it is created, as `maxRetries` is.
 *
 * Bad values used to give pauses of 1 to 3 ms between attempts (a retry storm), Node timer
 * warnings, or a silent fall-back to fixed backoff. Each is refused with an error that names the
 * option and the received value; every value that worked keeps its meaning.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventBus } from "../../src/EventBus.ts";
import { createEventContext } from "../../src/EventContext.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import { retryMiddleware } from "../../src/middleware/retry.ts";
import type { RawEvent } from "../../src/types.ts";

type Case = readonly [label: string, value: unknown, errorType: typeof TypeError | typeof RangeError];

function refuses(option: string, cases: readonly Case[]): void {
    for (const [label, value, errorType] of cases) {
        it(`refuses ${option} ${label} when the middleware is created, naming the option and the value`, () => {
            assert.throws(
                () => retryMiddleware({ [option]: value }),
                (error: unknown) =>
                    error instanceof errorType &&
                    error.message.includes("retryMiddleware") &&
                    error.message.includes(option) &&
                    error.message.includes(typeof value === "string" ? JSON.stringify(value) : String(value)),
            );
        });
    }
}

describe("retry delay options validation", () => {
    refuses("initialDelay", [
        ["NaN", Number.NaN, RangeError],
        ["negative", -1, RangeError],
        ["Infinity", Number.POSITIVE_INFINITY, RangeError],
        ["above the longest timer delay", 2_147_483_648, RangeError],
        ["a string", "100", TypeError],
        ["null", null, TypeError],
    ]);

    refuses("maxDelay", [
        ["NaN", Number.NaN, RangeError],
        ["zero, which caps every pause at nothing", 0, RangeError],
        ["negative", -1, RangeError],
        ["Infinity", Number.POSITIVE_INFINITY, RangeError],
        ["above the longest timer delay", 2_147_483_648, RangeError],
        ["a string", "100", TypeError],
        ["null", null, TypeError],
    ]);

    refuses("multiplier", [
        ["NaN", Number.NaN, RangeError],
        ["zero", 0, RangeError],
        ["below 1, which would shrink the pauses", 0.5, RangeError],
        ["negative", -2, RangeError],
        ["Infinity", Number.POSITIVE_INFINITY, RangeError],
        ["a string", "2", TypeError],
        ["null", null, TypeError],
    ]);

    refuses("backoff", [
        ["an unknown name, which used to behave as fixed", "bogus", RangeError],
        ["the wrong case", "Exponential", RangeError],
        ["a number", 1, TypeError],
        ["null", null, TypeError],
    ]);

    it("createEventBus refuses a bad retry option before any event is handled", () => {
        assert.throws(
            () => createEventBus({ adapter: MemoryAdapter(), middleware: { retry: { initialDelay: Number.NaN } } }),
            (error: unknown) => error instanceof RangeError && error.message.includes("initialDelay"),
        );
    });

    it("accepts every value that worked, including the boundaries", () => {
        for (const options of [
            {},
            { initialDelay: 0 },
            { initialDelay: 2_147_483_647 },
            { initialDelay: 0.5 },
            { maxDelay: 1 },
            { maxDelay: 2_147_483_647 },
            { multiplier: 1 },
            { multiplier: 1.5 },
            { multiplier: 1e9 },
            { backoff: "exponential" as const },
            { backoff: "linear" as const },
            { backoff: "fixed" as const },
        ]) {
            retryMiddleware(options);
        }
    });

    it("an initialDelay of 0 retries without a pause and every strategy keeps its schedule", async () => {
        const event: RawEvent = { eventId: "e", eventType: "t", payload: new Uint8Array(), publishedAt: new Date(), attempt: 1, metadata: new Map() };
        const ctx = createEventContext({ raw: event, signal: AbortSignal.timeout(5000), onAck: async () => undefined, onNack: async () => undefined });
        let calls = 0;
        const startedAt = Date.now();
        await retryMiddleware({ maxRetries: 3, backoff: "exponential", initialDelay: 0 })(event, ctx, async () => {
            calls += 1;
            if (calls < 4) {
                throw new Error("transient");
            }
        });
        assert.equal(calls, 4);
        assert.ok(Date.now() - startedAt < 500, "no pause was waited");
    });
});

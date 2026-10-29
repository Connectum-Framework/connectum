/**
 * `drainTimeout` is checked when the bus is created.
 *
 * `NaN` and negative values aborted running handlers the moment `stop()` was called. `Infinity`
 * (and anything above the longest timer delay) never aborted them and made the drain loop poll
 * every millisecond, one `TimeoutOverflowWarning` each. `0` stays valid: it aborts at once, as
 * documented.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.DrainTimeoutValidationService", methods: [fakeMethod] } as any;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("drainTimeout validation", () => {
    for (const [label, value, errorType] of [
        ["NaN", Number.NaN, RangeError],
        ["a negative number", -1, RangeError],
        ["Infinity", Number.POSITIVE_INFINITY, RangeError],
        ["a number above the longest timer delay", 2_147_483_648, RangeError],
        ["a string", "5", TypeError],
        ["null", null, TypeError],
    ] as const) {
        it(`refuses ${label} when the bus is created, naming the option and the value`, () => {
            assert.throws(
                () => createEventBus({ adapter: MemoryAdapter(), drainTimeout: value as unknown as number }),
                (error: unknown) =>
                    error instanceof errorType &&
                    error.message.includes("createEventBus") &&
                    error.message.includes("drainTimeout") &&
                    error.message.includes(typeof value === "string" ? JSON.stringify(value) : String(value)),
            );
        });
    }

    for (const value of [0, 1.5, 30, 2_147_483_647]) {
        it(`accepts ${value}`, () => {
            createEventBus({ adapter: MemoryAdapter(), drainTimeout: value });
        });
    }

    it("an accepted value still aborts a running handler at that time, not at once", async () => {
        let abortedAfterMs: number | undefined;
        const bus = createEventBus({
            adapter: MemoryAdapter(),
            drainTimeout: 80,
            routes: [
                (router) => {
                    router.service(fakeService, {
                        simpleEvent: async (_message: unknown, ctx: { signal: AbortSignal }) => {
                            const startedAt = Date.now();
                            await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
                            abortedAfterMs = Date.now() - startedAt;
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start();
        const published = bus.publish(EventOptionsSchema, create(EventOptionsSchema, {}));
        await sleep(20);
        await bus.stop();
        await published;

        assert.ok(abortedAfterMs !== undefined && abortedAfterMs >= 70, `the handler was aborted after ${abortedAfterMs} ms, expected about 100`);
    });
});

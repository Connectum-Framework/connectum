/**
 * `handlerTimeout` is checked when the bus is created.
 *
 * A bad value made `AbortSignal.timeout()` throw on every delivery, so the handler never ran
 * (`NaN`, negative, fractional, above 32 bits, a string), or aborted every signal at once (`0`).
 * It is refused with an error that names the option, and every value that worked keeps working.
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
const fakeService = { typeName: "test.v1.HandlerTimeoutValidationService", methods: [fakeMethod] } as any;

describe("handlerTimeout validation", () => {
    for (const [label, value, errorType] of [
        ["NaN", Number.NaN, RangeError],
        ["a negative number", -1, RangeError],
        ["zero, which aborts every signal before the handler runs", 0, RangeError],
        ["a fraction, which AbortSignal.timeout() refuses", 1.5, RangeError],
        ["Infinity", Number.POSITIVE_INFINITY, RangeError],
        ["a number above the 32-bit limit of AbortSignal.timeout()", 2 ** 32, RangeError],
        ["a string", "abc", TypeError],
        ["null", null, TypeError],
    ] as const) {
        it(`refuses ${label} when the bus is created, naming the option and the value`, () => {
            assert.throws(
                () => createEventBus({ adapter: MemoryAdapter(), handlerTimeout: value as unknown as number }),
                (error: unknown) =>
                    error instanceof errorType &&
                    error.message.includes("createEventBus") &&
                    error.message.includes("handlerTimeout") &&
                    error.message.includes(typeof value === "string" ? JSON.stringify(value) : String(value)),
            );
        });
    }

    for (const value of [1, 30_000, 2 ** 32 - 1]) {
        it(`accepts ${value}, and AbortSignal.timeout() takes it too`, () => {
            createEventBus({ adapter: MemoryAdapter(), handlerTimeout: value });
            assert.doesNotThrow(() => AbortSignal.timeout(value));
        });
    }

    // Fractions and numbers above 32 bits are not in this list on purpose: Node refuses them and Bun
    // accepts them. The bus refuses them so that a configuration that works on one runtime does not
    // fail every delivery on the other.
    it("AbortSignal.timeout() refuses the other values the bus refuses, on every runtime", () => {
        for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
            assert.throws(() => AbortSignal.timeout(value), `${value} must fail in AbortSignal.timeout()`);
        }
    });

    it("an accepted value limits the handler signal as before", async () => {
        let abortedAfterMs: number | undefined;
        const bus = createEventBus({
            adapter: MemoryAdapter(),
            handlerTimeout: 40,
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
        await bus.publish(EventOptionsSchema, create(EventOptionsSchema, {}));
        await bus.stop();

        assert.ok(abortedAfterMs !== undefined && abortedAfterMs >= 30, `the signal fired after ${abortedAfterMs} ms, not at once`);
    });
});

/**
 * Default time budgets of the bus: a bus created without `drainTimeout` gives
 * running handlers 30 000 ms to finish during `stop()` before it aborts them,
 * and a bus created without `handlerTimeout` limits each event's handler signal
 * to 30 000 ms. Both defaults are documented in the events guide and the package
 * README. The tests run on virtual time, so no test waits half a minute.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventBusOptions, RawEvent, RawEventHandler } from "../../src/types.ts";

const DOCUMENTED_DEFAULT_MS = 30_000;

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.DefaultTimeoutsService", methods: [fakeMethod] } as any;

const rawEvent = (): RawEvent => ({
    eventId: "evt-1",
    eventType: EventOptionsSchema.typeName,
    payload: new Uint8Array(),
    publishedAt: new Date(),
    attempt: 1,
    metadata: new Map(),
});

/** Lets promise continuations and zero-delay native callbacks run; `setImmediate` is not part of the virtual clock. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A bus whose single handler records its signal and never finishes on its own. */
function makeBus(options: Pick<EventBusOptions, "drainTimeout" | "handlerTimeout"> = {}) {
    let wrapped: RawEventHandler | null = null;
    let signal: AbortSignal | undefined;
    const adapter: EventAdapter = {
        name: "default-timeouts",
        connect: async () => undefined,
        disconnect: async () => undefined,
        publish: async () => undefined,
        subscribe: async (_patterns, handler) => {
            wrapped = handler;
            return { unsubscribe: async () => undefined };
        },
    };
    const bus = createEventBus({
        adapter,
        ...options,
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: (_msg: unknown, ctx: { signal: AbortSignal }) => {
                        signal = ctx.signal;
                        return new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
                    },
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
    });
    return {
        bus,
        deliver: (): Promise<void> =>
            (wrapped as RawEventHandler)(
                rawEvent(),
                async () => undefined,
                async () => undefined,
            ),
        handlerSignal: () => signal,
    };
}

// Virtual time and method spies come from the Node.js test runner; Bun's test engine does not provide them.
const SKIP_WITHOUT_MOCKS = typeof mock.method === "function" && typeof mock.timers?.enable === "function" ? false : "mock.method and mock.timers are unavailable in this test engine";

describe("default time budgets of the event bus", { skip: SKIP_WITHOUT_MOCKS }, () => {
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    it("drainTimeout defaults to 30 000 ms: a running handler is aborted exactly when that budget is spent", async () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        // handlerTimeout is set far above the drain budget so only the drain can abort the handler.
        const harness = makeBus({ handlerTimeout: 3_600_000 });
        await harness.bus.start();
        const handlerDone = harness.deliver();
        await settle();
        const stopped = harness.bus.stop();
        await settle();

        mock.timers.tick(DOCUMENTED_DEFAULT_MS - 1);
        await settle();
        assert.equal(harness.handlerSignal()?.aborted, false, "one millisecond before the budget is spent the handler is still running");

        mock.timers.tick(1);
        await settle();
        assert.equal(harness.handlerSignal()?.aborted, true, "the handler is aborted once the budget is spent");
        assert.equal(harness.handlerSignal()?.reason, "Drain timeout exceeded");

        await handlerDone;
        await stopped;
    });

    it("handlerTimeout defaults to 30 000 ms: each event's handler signal is limited to that time", async () => {
        // A native timeout signal cannot be moved on virtual time, so the requested
        // duration is recorded and the signal is handed back under the test's control.
        const requested: number[] = [];
        const timeoutSignal = new AbortController();
        mock.method(AbortSignal, "timeout", (ms: number) => {
            requested.push(ms);
            return timeoutSignal.signal;
        });
        const harness = makeBus();
        await harness.bus.start();
        const handlerDone = harness.deliver();
        await settle();

        assert.deepEqual(requested, [DOCUMENTED_DEFAULT_MS], "the handler signal is limited to the documented default");
        assert.equal(harness.handlerSignal()?.aborted, false);

        timeoutSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        await handlerDone;
        assert.equal(harness.handlerSignal()?.aborted, true, "when that limit is reached the handler signal aborts");
        await harness.bus.stop();
    });
});

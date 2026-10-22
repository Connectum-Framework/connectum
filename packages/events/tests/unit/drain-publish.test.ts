/**
 * Tests for the opt-in symmetric publish drain (`drainPublishTimeout`, #196).
 *
 * Uses a controllable fake adapter (deferred publish promises) so the tests
 * pin the BUS-level drain semantics without any broker:
 * - default (unset): bit-for-bit — stop() does not wait for pending publishes
 * - set: stop() waits for pending publishes to settle BEFORE disconnect
 * - set: a never-settling publish releases stop() at the deadline
 * - the stopping gate still rejects publishes issued during stop()
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventSubscription, RawEvent, RawEventHandler } from "../../src/types.ts";

/** A minimal valid message instance for publish(). */
const eventMsg = () => create(EventOptionsSchema, {});

interface Deferred {
    resolve: () => void;
    reject: (err: Error) => void;
}

/**
 * Fake adapter whose publish() promises settle only when the test says so.
 * Records the order of `publish-settled` / `disconnect` for assertions.
 */
function makeControlledAdapter(order: string[]) {
    const pending: Deferred[] = [];
    const adapter: EventAdapter = {
        name: "controlled",
        connect: async () => undefined,
        disconnect: async () => {
            order.push("disconnect");
        },
        publish: () =>
            new Promise<void>((resolve, reject) => {
                pending.push({
                    resolve: () => {
                        order.push("publish-settled");
                        resolve();
                    },
                    reject: (err: Error) => {
                        order.push("publish-rejected");
                        reject(err);
                    },
                });
            }),
        subscribe: async (): Promise<EventSubscription> => ({
            unsubscribe: async () => undefined,
        }),
    };
    return { adapter, pending };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("drainPublishTimeout (#196)", () => {
    it("default (unset): stop() does NOT wait for a pending publish — bit-for-bit regression pin", async () => {
        const order: string[] = [];
        const { adapter, pending } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter });
        await bus.start();

        const publishSettled = bus.publish(EventOptionsSchema, eventMsg()).catch(() => undefined);
        await sleep(10); // let publish reach the adapter

        // The publish never settles on its own. A bus that waited for it (for
        // example under a non-zero built-in default budget) would still be inside
        // stop() when the guard timer fires, so a bounded race tells "returns
        // promptly" from "waits for the publish" without a 30 s test.
        let guard: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            bus.stop().then(() => "stopped" as const),
            new Promise<"still waiting">((resolve) => {
                guard = setTimeout(() => resolve("still waiting"), 1_000);
            }),
        ]);
        clearTimeout(guard);
        const orderAtOutcome = [...order];

        // Settle afterwards — releases a waiting bus too, must not throw or become unhandled.
        pending[0]?.resolve();
        await publishSettled;

        assert.equal(outcome, "stopped", "stop() must return without waiting for the pending publish by default");
        assert.deepEqual(orderAtOutcome, ["disconnect"], "stop() must not wait for the pending publish by default");
    });

    it("set: stop() waits for the pending publish to settle before disconnect", async () => {
        const order: string[] = [];
        const { adapter, pending } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: 5_000 });
        await bus.start();

        const publishSettled = bus.publish(EventOptionsSchema, eventMsg());
        await sleep(10);

        const stopping = bus.stop();
        // The publish settles 50ms into the drain window.
        setTimeout(() => pending[0]?.resolve(), 50);
        await stopping;

        assert.deepEqual(order, ["publish-settled", "disconnect"], "disconnect must come after the drained publish");
        await publishSettled;
    });

    it("set: a rejecting publish also counts as settled (and never becomes unhandled)", async () => {
        const order: string[] = [];
        const { adapter, pending } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: 5_000 });
        await bus.start();

        const publishSettled = bus.publish(EventOptionsSchema, eventMsg()).catch((err: unknown) => {
            order.push(`caller-saw:${(err as Error).message}`);
        });
        await sleep(10);

        const stopping = bus.stop();
        setTimeout(() => pending[0]?.reject(new Error("nacked")), 50);
        await stopping;
        await publishSettled;

        assert.deepEqual(order, ["publish-rejected", "caller-saw:nacked", "disconnect"], "rejection settles the drain and still reaches the caller");
    });

    it("set: a never-settling publish releases stop() at the deadline", async () => {
        const order: string[] = [];
        const { adapter } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: 120 });
        await bus.start();

        void bus.publish(EventOptionsSchema, eventMsg()).catch(() => undefined);
        await sleep(10);

        const startedAt = Date.now();
        await bus.stop();
        const took = Date.now() - startedAt;

        assert.ok(took >= 100, `stop() must hold for the drain window (took ${took}ms)`);
        assert.ok(took < 2_000, `stop() must release at the deadline, not hang (took ${took}ms)`);
        assert.deepEqual(order, ["disconnect"], "disconnect proceeds after the deadline");
    });

    it("stopping gate: publish() during stop() still throws (drain does not admit new publishes)", async () => {
        const order: string[] = [];
        const { adapter } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: 100 });
        await bus.start();

        void bus.publish(EventOptionsSchema, eventMsg()).catch(() => undefined);
        await sleep(10);

        const stopping = bus.stop();
        await assert.rejects(
            () => bus.publish(EventOptionsSchema, eventMsg()),
            /EventBus is stopping/,
            "the stopping gate is unchanged — new publishes are rejected during stop()",
        );
        await stopping;
    });

    it("combined drains: handler force-abort fires at ITS deadline while the publish drain still holds stop() (slower-of, not sum)", async () => {
        // Adapter that captures the wrapped handler (so the test can put a
        // handler in flight) and whose publish never settles.
        let capturedHandler: RawEventHandler | null = null;
        const adapter: EventAdapter = {
            name: "combined",
            connect: async () => undefined,
            disconnect: async () => undefined,
            publish: () => new Promise<void>(() => undefined),
            subscribe: async (_patterns, handler): Promise<EventSubscription> => {
                capturedHandler = handler;
                return { unsubscribe: async () => undefined };
            },
        };

        const fakeMethod = {
            localName: "simpleEvent",
            input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
            proto: { options: undefined },
            // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const fakeService = { typeName: "test.v1.DrainService", methods: [fakeMethod] } as any;

        let abortObservedAt = 0;
        const bus = createEventBus({
            adapter,
            // Budgets far enough apart that "slower of the two" (~1000ms) and
            // "their sum" (~1300ms) are separated by more than scheduler jitter.
            drainTimeout: 300,
            drainPublishTimeout: 1_000,
            routes: [
                (router) => {
                    router.service(fakeService, {
                        // Handler hangs until the drain force-abort fires.
                        simpleEvent: async (_msg: unknown, ctx: { signal: AbortSignal }) => {
                            await new Promise<void>((resolve) => {
                                ctx.signal.addEventListener(
                                    "abort",
                                    () => {
                                        abortObservedAt = Date.now();
                                        resolve();
                                    },
                                    { once: true },
                                );
                            });
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start();

        assert.ok(capturedHandler, "subscribe must have captured the wrapped handler");
        const rawEvent: RawEvent = {
            eventId: "evt-drain-combined",
            eventType: EventOptionsSchema.typeName,
            payload: new Uint8Array(),
            publishedAt: new Date(),
            attempt: 1,
            metadata: new Map(),
        };
        // In-flight handler (not awaited) + in-flight publish (never settles).
        const handlerDone = (capturedHandler as RawEventHandler)(
            rawEvent,
            async () => undefined,
            async () => undefined,
        );
        void bus.publish(EventOptionsSchema, eventMsg()).catch(() => undefined);
        await sleep(10);

        const stopStartedAt = Date.now();
        await bus.stop();
        const stopTook = Date.now() - stopStartedAt;
        await handlerDone;

        assert.ok(abortObservedAt > 0, "the hung handler must have been force-aborted");
        const abortLatency = abortObservedAt - stopStartedAt;
        assert.ok(abortLatency >= 250, `force-abort must wait for the handler drain budget, not fire immediately (fired at ${abortLatency}ms)`);
        assert.ok(abortLatency < 700, `force-abort must fire at the HANDLER drain deadline (~300ms), not after the publish drain (fired at ${abortLatency}ms)`);
        assert.ok(stopTook >= 950, `stop() must still hold for the publish budget (took ${stopTook}ms)`);
        assert.ok(stopTook < 1_200, `stop() must be slower-of (~1000ms), never the sum (~1300ms) (took ${stopTook}ms)`);
    });

    it("0 disables waiting (same as unset)", async () => {
        const order: string[] = [];
        const { adapter, pending } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: 0 });
        await bus.start();

        const publishSettled = bus.publish(EventOptionsSchema, eventMsg()).catch(() => undefined);
        await sleep(10);

        await bus.stop();
        assert.deepEqual(order, ["disconnect"], "0 must not enable tracking or waiting");
        pending[0]?.resolve();
        await publishSettled;
    });

    it("a negative value disables waiting, like 0 and unset", async () => {
        const order: string[] = [];
        const { adapter, pending } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: -1 });
        await bus.start();

        const publishSettled = bus.publish(EventOptionsSchema, eventMsg()).catch(() => undefined);
        await sleep(10);

        // A negative budget read as "wait" would hold stop() for the whole pending publish: a bounded
        // race tells "returns promptly" from "waits" without a long test.
        let guard: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            bus.stop().then(() => "stopped" as const),
            new Promise<"still waiting">((resolve) => {
                guard = setTimeout(() => resolve("still waiting"), 1_000);
            }),
        ]);
        clearTimeout(guard);
        const orderAtOutcome = [...order];
        pending[0]?.resolve();
        await publishSettled;

        assert.equal(outcome, "stopped", "stop() must not wait for the pending publish under a negative budget");
        assert.deepEqual(orderAtOutcome, ["disconnect"], "a negative budget must not enable tracking or waiting");
    });

    it("a publish that settled before stop() does not hold stop() for the budget", async () => {
        const order: string[] = [];
        const { adapter, pending } = makeControlledAdapter(order);
        const bus = createEventBus({ adapter, drainPublishTimeout: 5_000 });
        await bus.start();

        const publishSettled = bus.publish(EventOptionsSchema, eventMsg());
        await sleep(10);
        pending[0]?.resolve();
        await publishSettled;
        await sleep(10); // let the bus observe the settled publish

        const startedAt = Date.now();
        await bus.stop();
        const took = Date.now() - startedAt;

        assert.ok(took < 1_000, `a settled publish must have left the in-flight set, so stop() returns at once (took ${took}ms of a 5000ms budget)`);
    });
});

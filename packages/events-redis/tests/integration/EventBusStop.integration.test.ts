/**
 * EventBus shutdown against a real Redis.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint.
 *
 * `RedisAdapter` closes a subscription by waiting for its read loop, and the
 * loop is busy for as long as the handler of the current entry runs. A handler
 * that never finishes on its own must therefore be cancelled by the bus after
 * `drainTimeout`, not after the (much longer) per-event `handlerTimeout`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

const eventMethod = {
    localName: "simpleEvent",
    input: EventOptionsSchema,
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const eventService = { typeName: "integration.v1.StopService", methods: [eventMethod] } as any;

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

describe("EventBus.stop() on Redis", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    it("force-aborts a handler that never finishes at drainTimeout, not at handlerTimeout", async () => {
        const publisher = RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 5 } });
        const consumer = RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 5 } });

        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let abortReason: unknown;
        let handlerReturned = false;

        const bus = createEventBus({
            adapter: consumer,
            group: `stop-${randomUUID()}`,
            drainTimeout: 400,
            handlerTimeout: 60_000,
            routes: [
                (router) => {
                    router.service(eventService, {
                        simpleEvent: async (_message: unknown, ctx: { signal: AbortSignal }) => {
                            handlerStarted();
                            await new Promise<void>((resolve) => {
                                ctx.signal.addEventListener("abort", () => resolve(), { once: true });
                            });
                            abortReason = ctx.signal.reason;
                            handlerReturned = true;
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });

        await publisher.connect({ serviceName: "integration-stop-publisher" });
        try {
            await bus.start();
            await publisher.publish(EventOptionsSchema.typeName, new Uint8Array());
            await withTimeout(started, "handler start", 10_000);

            const startedAt = Date.now();
            await withTimeout(bus.stop(), "bus.stop()", 20_000);
            const took = Date.now() - startedAt;

            assert.ok(handlerReturned, "the handler must have been released by the abort before stop() resolved");
            assert.equal(abortReason, "Drain timeout exceeded");
            assert.ok(took >= 350, `stop() must still give the handler its drain window (took ${took}ms)`);
            assert.ok(took < 5_000, `stop() must be bounded by drainTimeout, not by handlerTimeout (took ${took}ms)`);
        } finally {
            await publisher.disconnect();
        }
    });
});

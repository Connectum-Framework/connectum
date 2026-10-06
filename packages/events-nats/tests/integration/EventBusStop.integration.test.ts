/**
 * EventBus shutdown against a real NATS JetStream server.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/EventBusStop.integration.test.ts
 *
 * A handler that never finishes on its own must be cancelled by the bus after
 * `drainTimeout`, not after the (much longer) per-event `handlerTimeout`,
 * whatever the adapter does while closing its subscription.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

describe("EventBus.stop() on NATS", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("force-aborts a handler that never finishes at drainTimeout, not at handlerTimeout", { timeout: 120_000 }, async () => {
        // The subject is derived from the input message type name; a unique one keeps runs independent.
        const eventType = `it.stop.${randomUUID().replaceAll("-", "")}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: eventType, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.StopService", methods: [method] } as any;

        const stream = `itstop${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const publisher = NatsAdapter({ servers, stream });

        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let abortReason: unknown;
        let handlerReturned = false;

        const bus = createEventBus({
            adapter: NatsAdapter({ servers, stream }),
            group: `stop-${randomUUID().replaceAll("-", "")}`,
            drainTimeout: 400,
            handlerTimeout: 60_000,
            routes: [
                (router) => {
                    router.service(service, {
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
            await publisher.publish(eventType, new Uint8Array());
            await withTimeout(started, "handler start", 30_000);

            const startedAt = Date.now();
            await withTimeout(bus.stop(), "bus.stop()", 40_000);
            const took = Date.now() - startedAt;

            assert.ok(handlerReturned, "the handler must have been released by the abort before stop() resolved");
            assert.equal(abortReason, "Drain timeout exceeded");
            assert.ok(took >= 350, `stop() must still give the handler its drain window (took ${took}ms)`);
            assert.ok(took < 10_000, `stop() must be bounded by drainTimeout, not by handlerTimeout (took ${took}ms)`);
        } finally {
            await publisher.disconnect();
        }
    });
});

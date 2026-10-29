/**
 * `dlq.attempt` is the broker's delivery number of the original message.
 *
 * The dead-letter middleware sits outside the retry middleware and publishes the attempt of the
 * event it received. Retries made inside the process are not counted: a handler that ran three
 * times for one delivery still produces `dlq.attempt` equal to the delivery number the adapter
 * reported. The events middleware guide documents exactly this, and this test keeps the guide and
 * the code from drifting apart.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler } from "../../src/types.ts";

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.DlqAttemptService", methods: [fakeMethod] } as any;

async function deadLetterHeaders(deliveryAttempt: number): Promise<{ handlerCalls: number; headers: Record<string, string> | undefined }> {
    let captured: RawEventHandler | null = null;
    const dlq: Array<Record<string, string> | undefined> = [];
    const adapter: EventAdapter = {
        name: "dlq-attempt",
        connect: async () => undefined,
        disconnect: async () => undefined,
        publish: async (_topic: string, _payload: Uint8Array, options?: PublishOptions) => {
            dlq.push(options?.metadata);
        },
        subscribe: async (_patterns, handler): Promise<EventSubscription> => {
            captured = handler;
            return { unsubscribe: async () => undefined };
        },
    };
    let handlerCalls = 0;
    const bus = createEventBus({
        adapter,
        middleware: { retry: { maxRetries: 2, backoff: "fixed", initialDelay: 1 }, dlq: { topic: "attempt.dlq" } },
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: async () => {
                        handlerCalls += 1;
                        throw new Error("poison");
                    },
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
    });
    await bus.start();
    const raw: RawEvent = {
        eventId: "evt-attempt",
        eventType: EventOptionsSchema.typeName,
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: deliveryAttempt,
        metadata: new Map(),
    };
    await (captured as unknown as RawEventHandler)(
        raw,
        async () => undefined,
        async () => undefined,
    );
    await bus.stop();
    return { handlerCalls, headers: dlq[0] };
}

describe("dlq.attempt", () => {
    it("is the delivery number the adapter reported, not the number of handler runs", async () => {
        const first = await deadLetterHeaders(1);
        assert.equal(first.handlerCalls, 3, "the handler ran for the original attempt and two retries");
        assert.equal(first.headers?.["dlq.attempt"], "1");

        const redelivered = await deadLetterHeaders(5);
        assert.equal(redelivered.handlerCalls, 3);
        assert.equal(redelivered.headers?.["dlq.attempt"], "5");
    });
});

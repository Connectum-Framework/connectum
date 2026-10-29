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
import { createEventContext } from "../../src/EventContext.ts";
import { NonRetryableError } from "../../src/errors.ts";
import { dlqMiddleware } from "../../src/middleware/dlq.ts";
import { retryMiddleware } from "../../src/middleware/retry.ts";
import { composeMiddleware } from "../../src/middleware.ts";
import type { EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RetryOptions } from "../../src/types.ts";

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

describe("dlq.handler-runs", () => {
    it("is the number of handler invocations of the delivery, first run included, next to an unchanged dlq.attempt", async () => {
        const first = await deadLetterHeaders(1);
        assert.equal(first.headers?.["dlq.handler-runs"], "3");
        assert.equal(first.headers?.["dlq.attempt"], "1");

        const redelivered = await deadLetterHeaders(5);
        assert.equal(redelivered.headers?.["dlq.handler-runs"], "3", "counts runs of this delivery only, not the broker's delivery number");
        assert.equal(redelivered.headers?.["dlq.attempt"], "5");
    });

    function dlqFor(retry: RetryOptions | undefined, handler: () => Promise<void>) {
        const published: Array<Record<string, string> | undefined> = [];
        const event: RawEvent = { eventId: "e", eventType: "t", payload: new Uint8Array(), publishedAt: new Date(), attempt: 1, metadata: new Map() };
        const ctx = createEventContext({ raw: event, signal: AbortSignal.timeout(5000), onAck: async () => undefined, onNack: async () => undefined });
        const chain = [
            dlqMiddleware({ topic: "runs.dlq" }, { publish: async (_topic, _payload, options) => void published.push(options?.metadata) }),
            ...(retry === undefined ? [] : [retryMiddleware(retry)]),
        ];
        return { run: () => composeMiddleware(chain, handler)(event, ctx), published };
    }

    it("is 1 when the dead-letter middleware runs without the retry middleware", async () => {
        const { run, published } = dlqFor(undefined, async () => {
            throw new Error("poison");
        });
        await run();
        assert.equal(published[0]?.["dlq.handler-runs"], "1");
    });

    it("is 1 for maxRetries 0 and for an error that is not retried", async () => {
        const zero = dlqFor({ maxRetries: 0 }, async () => {
            throw new Error("poison");
        });
        await zero.run();
        assert.equal(zero.published[0]?.["dlq.handler-runs"], "1");

        const nonRetryable = dlqFor({ maxRetries: 3, initialDelay: 1 }, async () => {
            throw new NonRetryableError("invalid");
        });
        await nonRetryable.run();
        assert.equal(nonRetryable.published[0]?.["dlq.handler-runs"], "1");
    });

    it("counts the runs made before a retry was cut short by the retry predicate", async () => {
        let calls = 0;
        const { run, published } = dlqFor({ maxRetries: 5, backoff: "fixed", initialDelay: 1, retryableErrors: () => calls < 2 }, async () => {
            calls += 1;
            throw new Error("poison");
        });
        await run();
        assert.equal(published[0]?.["dlq.handler-runs"], String(calls));
        assert.equal(calls, 2);
    });
});

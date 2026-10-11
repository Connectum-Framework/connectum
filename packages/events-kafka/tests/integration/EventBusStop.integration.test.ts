/**
 * EventBus shutdown against a real Kafka broker.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real
 * single-node broker (see the adapter integration suite for a docker command).
 *
 * `KafkaAdapter` closes a subscription with `consumer.disconnect()`, which
 * waits for the running `eachBatch`. A handler that never finishes on its own
 * must therefore be cancelled by the bus after `drainTimeout`, not after the
 * (much longer) per-event `handlerTimeout`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

describe("EventBus.stop() on Kafka", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    it("force-aborts a handler that never finishes at drainTimeout, not at handlerTimeout", { timeout: 120_000 }, async () => {
        // The topic is derived from the input message type name; a unique one keeps runs independent.
        const topic = `it.stop.${randomUUID().replaceAll("-", "")}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: topic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.StopService", methods: [method] } as any;

        const admin = new Kafka({ clientId: "integration-stop-control", brokers, logLevel: logLevel.ERROR }).admin();
        await admin.connect();
        try {
            await createTopicWithLeader(admin, topic);

            const newAdapter = () =>
                KafkaAdapter({
                    brokers,
                    clientId: `integration-stop-${randomUUID()}`,
                    kafkaConfig: { logLevel: logLevel.ERROR },
                    consumerOptions: { fromBeginning: true, redeliveryDelay: 0 },
                });
            const publisher = newAdapter();

            let handlerStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                handlerStarted = resolve;
            });
            let abortReason: unknown;
            let handlerReturned = false;

            const bus = createEventBus({
                adapter: newAdapter(),
                group: `stop-${randomUUID()}`,
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
                await publisher.publish(topic, new Uint8Array());
                await withTimeout(started, "handler start", 60_000);

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
        } finally {
            await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
            await admin.disconnect();
        }
    });
});

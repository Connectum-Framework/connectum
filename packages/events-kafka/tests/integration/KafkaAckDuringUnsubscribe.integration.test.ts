/**
 * A handler that is still running when `unsubscribe()` is called must still be able to acknowledge
 * its message: `EventBus.stop()` unsubscribes first and waits for the handlers afterwards.
 * `unsubscribe()` ends in `consumer.disconnect()`, which waits for the running batch; the question
 * answered here against a real broker is whether the offset commit made by `ack()` inside that
 * window reaches the broker, so the message is not delivered again to the group.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real single-node broker.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

describe("Kafka adapter: acknowledging while unsubscribe() runs", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    for (const commitStrategy of ["per-message", "per-batch"] as const) {
        it(`${commitStrategy}: the offset committed by ack() after unsubscribe() was called reaches the broker`, { timeout: 120_000 }, async () => {
            const topic = `it.ackunsub.${randomUUID().replaceAll("-", "")}`;
            const group = `g-${randomUUID()}`;
            const admin = new Kafka({ clientId: "integration-ackunsub-control", brokers, logLevel: logLevel.ERROR }).admin();
            await admin.connect();
            const newAdapter = () =>
                KafkaAdapter({
                    brokers,
                    clientId: `integration-ackunsub-${randomUUID()}`,
                    logLevel: "error",
                    consumerOptions: { fromBeginning: true, redeliveryDelay: 0, commitStrategy },
                });
            const publisher = newAdapter();
            const consumerAdapter = newAdapter();
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let started = false;
            let ackError: unknown;
            let acked = false;
            try {
                await createTopicWithLeader(admin, topic);
                await publisher.connect({ serviceName: "integration-ackunsub-publisher" });
                await consumerAdapter.connect({ serviceName: "integration-ackunsub-consumer" });
                const subscription = await consumerAdapter.subscribe(
                    [topic],
                    async (_event, ack) => {
                        started = true;
                        await gate;
                        try {
                            await ack();
                            acked = true;
                        } catch (error) {
                            ackError = error;
                        }
                    },
                    { group },
                );
                await publisher.publish(topic, new Uint8Array([1]));
                const deadline = Date.now() + 60_000;
                while (!started && Date.now() < deadline) {
                    await sleep(50);
                }
                assert.ok(started, "the handler must have started");

                // What EventBus.stop() does first; it resolves only when the running batch has ended.
                const unsubscribing = subscription.unsubscribe();
                await sleep(300);
                release();
                await unsubscribing.catch(() => undefined);
                await sleep(300);

                assert.equal(ackError, undefined, `ack() while unsubscribe() runs must not fail (got ${String(ackError)})`);
                assert.ok(acked, "ack() must have completed");
                const [committed] = await admin.fetchOffsets({ groupId: group, topics: [topic] });
                const offset = committed?.partitions[0]?.offset;
                assert.equal(offset, "1", `the committed offset must be past the message (got ${String(offset)})`);
            } finally {
                release();
                await consumerAdapter.disconnect().catch(() => undefined);
                await publisher.disconnect().catch(() => undefined);
                await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
                await admin.disconnect();
            }
        });
    }
});

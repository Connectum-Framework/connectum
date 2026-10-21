/**
 * Publishing to a name Kafka reserves ("", "." and "..") is refused with a TypeError that names the
 * adapter and the topic, before the producer sends anything; the broker's own answer does not name
 * the topic. Every other name with an empty segment (`a..b`, `.a`, `a.`) is a legal Kafka topic and
 * is published as before.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real single-node broker.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;
const SCENARIO_TIMEOUT_MS = 90_000;

describe("Kafka adapter: publishing to a topic with an empty segment", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    for (const topic of ["", ".", ".."] as const) {
        it(`rejects ${JSON.stringify(topic)}, a name Kafka reserves, with a TypeError naming the topic`, { timeout: SCENARIO_TIMEOUT_MS }, async () => {
            const adapter = KafkaAdapter({ brokers, clientId: `publish-reserved-${randomUUID()}` });
            await adapter.connect();
            try {
                await assert.rejects(
                    adapter.publish(topic, new Uint8Array([1])),
                    (error: unknown) =>
                        error instanceof TypeError && error.message === `KafkaAdapter: publish topic "${topic}" is not a valid Kafka topic name. Kafka reserves the names "", "." and "..".`,
                );
            } finally {
                await adapter.disconnect();
            }
        });
    }

    for (const [label, topicOf] of [
        ["an empty segment between dots", (id: string) => `${id}..b`],
        ["a leading dot", (id: string) => `.${id}`],
        ["a trailing dot", (id: string) => `${id}.`],
    ] as const) {
        it(`publishes to a legal Kafka topic with ${label}`, { timeout: SCENARIO_TIMEOUT_MS }, async () => {
            const topic = topicOf(`pub-${randomUUID().slice(0, 8)}`);
            const adapter = KafkaAdapter({ brokers, clientId: `publish-legal-${randomUUID()}` });
            await adapter.connect();
            try {
                await assert.doesNotReject(adapter.publish(topic, new Uint8Array([1])));
            } finally {
                await adapter.disconnect();
            }
        });
    }
});

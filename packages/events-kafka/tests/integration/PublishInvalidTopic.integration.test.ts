/**
 * Publishing to a topic name the broker refuses must say which name it was.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/PublishInvalidTopic.integration.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;
const payload = new Uint8Array([1]);

describe("Kafka publish to an invalid topic name", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const adapter = KafkaAdapter({ brokers, clientId: `invalid-topic-${randomUUID()}`, logLevel: "nothing" });

    before(async () => {
        await adapter.connect();
    });
    after(async () => {
        await adapter.disconnect();
    });

    it("names the topic in the error for a space, a wildcard, a non-ASCII name and a name of 250 characters", async () => {
        for (const topic of ["my topic", "my*topic", "тема", "x".repeat(250)]) {
            await assert.rejects(adapter.publish(topic, payload), (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.ok(err.message.includes(JSON.stringify(topic)), `message does not name the topic: ${err.message}`);
                assert.match(err.message, /249/);
                assert.ok(err.cause instanceof Error, "the broker's own error is kept as the cause");
                return true;
            }, topic);
        }
    });

    it("still publishes to a name of exactly 249 characters, the limit the message states", async () => {
        await adapter.publish(`${"x".repeat(200)}${randomUUID().replaceAll("-", "")}`.padEnd(249, "y"), payload);
    });
});

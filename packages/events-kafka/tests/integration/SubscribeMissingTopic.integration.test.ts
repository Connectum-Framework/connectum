/**
 * Subscribing to a topic that does not exist yet: with `allowAutoTopicCreation` the broker creates it and
 * the subscription works; without it the error names the topic and the option.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/SubscribeMissingTopic.integration.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const uniqueName = (prefix: string): string => `${prefix}-${randomUUID().replaceAll("-", "")}`;
const text = (value: Uint8Array): string => Buffer.from(value).toString("utf-8");

async function waitFor(cond: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

describe("Kafka subscribe to a topic that does not exist", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const admin = new Kafka({ clientId: uniqueName("missing-control"), brokers, logLevel: logLevel.NOTHING }).admin();
    let adminConnected = false;
    const adapters: ReturnType<typeof KafkaAdapter>[] = [];

    after(async () => {
        await Promise.allSettled(adapters.map((a) => a.disconnect()));
        if (adminConnected) {
            await admin.disconnect();
        }
    });

    async function topicExists(topic: string): Promise<boolean> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
        return (await admin.listTopics()).includes(topic);
    }

    async function connected(allowAutoTopicCreation: boolean) {
        const adapter = KafkaAdapter({ brokers, clientId: uniqueName("missing"), logLevel: "nothing", consumerOptions: { allowAutoTopicCreation, fromBeginning: true } });
        adapters.push(adapter);
        await adapter.connect();
        return adapter;
    }

    it("with allowAutoTopicCreation the broker creates the topic and the subscription receives what is published to it", { timeout: 60_000 }, async () => {
        const adapter = await connected(true);
        const topic = uniqueName("auto-created");
        const received: string[] = [];
        const subscription = await adapter.subscribe(
            [topic],
            async (event, ack) => {
                received.push(text(event.payload));
                await ack();
            },
            { group: uniqueName("g") },
        );
        assert.equal(await topicExists(topic), true, "the topic exists once subscribe() returned");
        await adapter.publish(topic, new TextEncoder().encode("hello"));
        await waitFor(() => received.length === 1, "the message is delivered");
        assert.deepEqual(received, ["hello"]);
        await subscription.unsubscribe();
    });

    it("without it subscribe() rejects with the topic and the option named, and creates nothing", { timeout: 60_000 }, async () => {
        const adapter = await connected(false);
        const topic = uniqueName("not-created");
        await assert.rejects(adapter.subscribe([topic], async (_event, ack) => ack(), { group: uniqueName("g") }), (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes(JSON.stringify(topic)), err.message);
            assert.match(err.message, /consumerOptions\.allowAutoTopicCreation/);
            return true;
        });
        assert.equal(await topicExists(topic), false);
    });
});

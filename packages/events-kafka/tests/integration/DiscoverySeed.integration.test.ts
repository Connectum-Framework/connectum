/**
 * What the set of topics a discovery starts from decides. The adapter lists the broker's topics
 * before it subscribes and hands that list to discovery as the topics already covered; a topic
 * that is not on it counts as new and is subscribed from its first message. A listing that failed
 * must therefore fail the subscription instead of leaving the list empty: an empty list makes
 * every topic that existed all along look new, and a group with no committed offset there would
 * read all of its history although `fromBeginning` is off.
 *
 * Set KAFKA_TEST_URL like for the other Kafka integration tests.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { startTopicDiscovery } from "../../src/topicDiscovery.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

describe("topic discovery seed", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",");
    const HISTORY = 3;

    /** Counts what a wildcard subscription on `root.*` receives from a topic that held `HISTORY` messages before it started. */
    async function receivedFromHistory(seed: "listed" | "empty"): Promise<number> {
        const kafka = new Kafka({ clientId: `seed-${seed}`, brokers, logLevel: logLevel.NOTHING });
        const admin = kafka.admin();
        await admin.connect();
        const producer = kafka.producer();
        await producer.connect();
        const root = `seed.${randomUUID().slice(0, 8)}`;
        const topic = `${root}.old`;
        await createTopicWithLeader(admin, topic);
        await producer.send({ topic, messages: Array.from({ length: HISTORY }, (_, i) => ({ value: `h${i}` })) });

        const consumer = kafka.consumer({ groupId: `seed-${randomUUID().slice(0, 8)}` });
        await consumer.connect();
        let received = 0;
        const runConfig = {
            eachMessage: async () => {
                received++;
            },
        } as const;
        const wildcard = new RegExp(`^${root}\\.`);
        let stop: (() => Promise<void>) | undefined;
        try {
            const known = new Set<string>();
            if (seed === "listed") {
                for (const name of await admin.listTopics()) known.add(name);
            }
            await consumer.subscribe({ topics: [wildcard], fromBeginning: false });
            await consumer.run(runConfig);
            stop = startTopicDiscovery({ consumer, wildcards: [wildcard], known, runConfig, resumeTimers: new Set(), interval: 500, listTopics: () => admin.listTopics() });
            await sleep(6_000);
            return received;
        } finally {
            await stop?.();
            await consumer.disconnect();
            await producer.disconnect();
            await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
            await admin.disconnect();
        }
    }

    it("a discovery seeded with the topics that exist does not touch their history", { timeout: 60_000 }, async () => {
        assert.equal(await receivedFromHistory("listed"), 0);
    });

    it("a discovery seeded with nothing reads the history of a topic that existed all along", { timeout: 60_000 }, async () => {
        assert.equal(await receivedFromHistory("empty"), HISTORY);
    });

    it("subscribe fails when the initial topic listing fails", { timeout: 60_000 }, async () => {
        const adapter = KafkaAdapter({
            brokers,
            kafkaConfig: { logLevel: logLevel.NOTHING },
            consumerOptions: { topicDiscoveryInterval: 60_000 },
        });
        await adapter.connect();
        const proto = Kafka.prototype as unknown as Record<string, unknown>;
        const originalAdmin = proto.admin;
        proto.admin = () => ({
            connect: async () => undefined,
            disconnect: async () => undefined,
            listTopics: async () => {
                throw new Error("describe denied");
            },
        });
        try {
            await assert.rejects(adapter.subscribe([`seed.${randomUUID().slice(0, 8)}.*`], async () => undefined, { group: `seed-${randomUUID().slice(0, 8)}` }), /describe denied/);
        } finally {
            proto.admin = originalAdmin;
            await adapter.disconnect();
        }
    });
});

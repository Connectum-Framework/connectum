/**
 * Two members of one group with very different discovery intervals: the KafkaJS group leader
 * assigns only the topics it has itself subscribed, and a member drops partitions of topics it has
 * not subscribed, so a new topic is fully consumed only once every member has discovered it. This
 * scenario measures that delay and checks that nothing is lost meanwhile.
 *
 * Set KAFKA_TEST_URL like for the other Kafka integration tests.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("topic discovery with skewed intervals", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",");

    it("a late-discovering member delays, but does not lose, the partitions assigned to it", { timeout: 120_000 }, async () => {
        const kafka = new Kafka({ clientId: "skew-control", brokers, logLevel: logLevel.NOTHING });
        const admin = kafka.admin();
        await admin.connect();
        const root = `skew.${randomUUID().slice(0, 8)}`;
        await admin.createTopics({ waitForLeaders: true, topics: [{ topic: `${root}.early`, numPartitions: 2, replicationFactor: 1 }] });
        const group = `skew-${randomUUID().slice(0, 8)}`;
        const fast = KafkaAdapter({ brokers, clientId: "skew-fast", kafkaConfig: { logLevel: logLevel.NOTHING }, consumerOptions: { fromBeginning: true, redeliveryDelay: 0, topicDiscoveryInterval: 1_000 } });
        const slow = KafkaAdapter({ brokers, clientId: "skew-slow", kafkaConfig: { logLevel: logLevel.NOTHING }, consumerOptions: { fromBeginning: true, redeliveryDelay: 0, topicDiscoveryInterval: 20_000 } });
        await fast.connect();
        await slow.connect();
        const arrivals = new Map<string, number>();
        const t0 = Date.now();
        const record = (who: string) => async (event: { payload: Uint8Array }, ack: () => Promise<void>) => {
            const key = Buffer.from(event.payload).toString();
            arrivals.set(`${who}:${key}`, Date.now() - t0);
            await ack();
        };
        const subFast = await fast.subscribe([`${root}.*`], record("fast"), { group });
        const subSlow = await slow.subscribe([`${root}.*`], record("slow"), { group });
        try {
            await sleep(6_000);
            const created = Date.now() - t0;
            await admin.createTopics({ waitForLeaders: true, topics: [{ topic: `${root}.late`, numPartitions: 4, replicationFactor: 1 }] });
            for (let i = 0; i < 12; i++) {
                await fast.publish(`${root}.late`, new Uint8Array(Buffer.from(`m${i}`)), { key: `k${i}` });
            }
            const deadline = Date.now() + 60_000;
            const delivered = () => new Set([...arrivals.keys()].map((k) => k.split(":")[1]));
            while (delivered().size < 12 && Date.now() < deadline) await sleep(500);
            const byMember = { fast: [...arrivals.keys()].filter((k) => k.startsWith("fast")).length, slow: [...arrivals.keys()].filter((k) => k.startsWith("slow")).length };
            const last = Math.max(...arrivals.values());
            console.log(`skew: topic created at ${created} ms; all 12 delivered: ${delivered().size === 12}; last arrival at ${last} ms (${last - created} ms after creation); per member ${JSON.stringify(byMember)}; total deliveries ${arrivals.size}`);
            assert.equal(delivered().size, 12, "every message of the late topic delivered");
        } finally {
            await subFast.unsubscribe();
            await subSlow.unsubscribe();
            await fast.disconnect();
            await slow.disconnect();
            await admin.deleteTopics({ topics: [`${root}.early`, `${root}.late`] }).catch(() => undefined);
            await admin.disconnect();
        }
    });
});

/**
 * A wildcard subscription survives the deletion of one of the topics it matched.
 *
 * KafkaJS keeps the topic list it was given and cannot drop a topic from a consumer, so after the
 * deletion the consumer crashed, restarted with the same list and crashed again, about once a
 * second, for roughly five minutes, while the healthy topic delivered nothing.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/WildcardTopicDeleted.integration.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import type { KafkaLifecycleEvent } from "../../src/types.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const uniqueName = (prefix: string): string => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const text = (value: Uint8Array): string => Buffer.from(value).toString("utf-8");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
        }
        await sleep(100);
    }
}

/** Longest the healthy topic may stay silent after the deletion; the unfixed adapter needed about 300 s. */
const RECOVERY_BUDGET_MS = 45_000;

describe("Kafka wildcard subscription after one matched topic is deleted", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const admin = new Kafka({ clientId: uniqueName("deleted-control"), brokers, logLevel: logLevel.NOTHING }).admin();
    let adminConnected = false;
    const adapters: ReturnType<typeof KafkaAdapter>[] = [];

    after(async () => {
        await Promise.allSettled(adapters.map((a) => a.disconnect()));
        if (adminConnected) {
            await admin.disconnect();
        }
    });

    async function ensureAdmin(): Promise<void> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
    }

    async function scenario(options: { topicDiscoveryInterval: number | false }) {
        await ensureAdmin();
        const prefix = uniqueName("del");
        const kept = `${prefix}.kept`;
        const doomed = `${prefix}.doomed`;
        await createTopicWithLeader(admin, kept);
        await createTopicWithLeader(admin, doomed);

        const events: KafkaLifecycleEvent[] = [];
        const received: string[] = [];
        const adapter = KafkaAdapter({
            brokers,
            clientId: uniqueName("deleted"),
            logLevel: "nothing",
            lifecycle: { onLifecycle: (event) => void events.push(event) },
            consumerOptions: { fromBeginning: true, redeliveryDelay: 0, topicDiscoveryInterval: options.topicDiscoveryInterval },
        });
        adapters.push(adapter);
        await adapter.connect();
        const subscription = await adapter.subscribe(
            [`${prefix}.*`],
            async (event, ack) => {
                received.push(text(event.payload));
                await ack();
            },
            { group: uniqueName("g") },
        );
        const publish = (topic: string, body: string) => adapter.publish(topic, new TextEncoder().encode(body));

        await publish(kept, "kept-before");
        await publish(doomed, "doomed-before");
        await waitFor(() => received.includes("kept-before") && received.includes("doomed-before"), "both topics deliver before the deletion", 30_000);
        return { prefix, kept, doomed, events, received, adapter, subscription, publish };
    }

    it("keeps delivering from the healthy topic within seconds, loses nothing published meanwhile, and reports the recovery", { timeout: 90_000 }, async () => {
        const { kept, doomed, events, received, subscription, publish } = await scenario({ topicDiscoveryInterval: false });

        await admin.deleteTopics({ topics: [doomed] });
        const sent: string[] = [];
        const startedAt = Date.now();
        for (let i = 1; i <= 10; i++) {
            const body = `kept-after-${i}`;
            await publish(kept, body);
            sent.push(body);
            await sleep(1_000);
        }
        await waitFor(() => sent.every((body) => received.includes(body)), `every message published after the deletion is delivered (got ${received.filter((b) => b.startsWith("kept-after")).length} of ${sent.length})`, RECOVERY_BUDGET_MS - (Date.now() - startedAt));

        assert.ok(
            events.some((e) => e.type === "consumer-lost"),
            "the crash is reported",
        );
        await waitFor(() => events.some((e) => e.type === "consumer-restored"), "consumer-restored is reported", 10_000);
        assert.ok(events.filter((e) => e.type === "consumer-restore-failed").length < 10, "restarts did not keep failing for the rest of the window");
        await subscription.unsubscribe();
    });

    it("recovers the same way when topic discovery is on, and consumes the deleted topic again once it is re-created", { timeout: 120_000 }, async () => {
        const { kept, doomed, received, subscription, publish } = await scenario({ topicDiscoveryInterval: 1_000 });

        await admin.deleteTopics({ topics: [doomed] });
        await publish(kept, "kept-after-delete");
        await waitFor(() => received.includes("kept-after-delete"), "the healthy topic delivers after the deletion", RECOVERY_BUDGET_MS);

        await createTopicWithLeader(admin, doomed);
        await publish(doomed, "doomed-reborn");
        await waitFor(() => received.includes("doomed-reborn"), "the re-created topic is consumed again", RECOVERY_BUDGET_MS);
        await subscription.unsubscribe();
    });
});

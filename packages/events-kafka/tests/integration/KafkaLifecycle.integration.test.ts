/**
 * Lifecycle events of the Kafka adapter that need a broker but no outage.
 *
 * The crash and recovery of a consumer needs a frozen broker and is covered by tests/lifecycle (opt-in); here
 * the events that must NOT appear, and the isolation of a failing callback, are checked on a healthy broker.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/KafkaLifecycle.integration.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import type { KafkaLifecycleEvent } from "../../src/types.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
        }
        await sleep(100);
    }
}

const uniqueName = (prefix: string): string => `${prefix}-${randomUUID().replaceAll("-", "")}`;
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "utf-8"));
const text = (value: Uint8Array): string => Buffer.from(value).toString("utf-8");

describe("Kafka adapter lifecycle events on a healthy broker", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const admin = new Kafka({ clientId: uniqueName("lifecycle-control"), brokers, logLevel: logLevel.NOTHING }).admin();
    let adminConnected = false;

    after(async () => {
        if (adminConnected) {
            await admin.disconnect();
        }
    });

    async function topicNamed(name: string): Promise<string> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
        await createTopicWithLeader(admin, name);
        return name;
    }

    const newAdapter = (onLifecycle: (event: KafkaLifecycleEvent) => void | Promise<void>) =>
        KafkaAdapter({
            brokers,
            clientId: uniqueName("lifecycle"),
            logLevel: "nothing",
            consumerOptions: { fromBeginning: true, redeliveryDelay: 0, topicDiscoveryInterval: 1_000 },
            lifecycle: { onLifecycle },
        });

    it("reports the producer's connect once, and nothing for a consumer that joins, consumes and is stopped in order", { timeout: 60_000 }, async () => {
        const topic = await topicNamed(uniqueName("lc.quiet"));
        const events: KafkaLifecycleEvent[] = [];
        const received: string[] = [];
        const adapter = newAdapter((event) => void events.push(event));

        await adapter.connect();
        try {
            assert.deepEqual(events, [{ type: "connected", reconnected: false }]);
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    received.push(text(event.payload));
                    await ack();
                },
                { group: uniqueName("group") },
            );
            await adapter.publish(topic, bytes("one"));
            await waitFor(() => received.includes("one"), "the message delivered");
            await subscription.unsubscribe();
            await adapter.disconnect();
            await sleep(500);
            assert.deepEqual(
                events.map((e) => e.type),
                ["connected"],
                "a first join, rebalances and our own stops are not losses",
            );
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("the restart that topic discovery causes is not a crash and reports nothing", { timeout: 60_000 }, async () => {
        const root = uniqueName("lc.discovery");
        await topicNamed(`${root}.early`);
        const events: KafkaLifecycleEvent[] = [];
        const received: string[] = [];
        const adapter = newAdapter((event) => void events.push(event));

        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(
                [`${root}.*`],
                async (event, ack) => {
                    received.push(text(event.payload));
                    await ack();
                },
                { group: uniqueName("group") },
            );
            const late = await topicNamed(`${root}.late`);
            await adapter.publish(late, bytes("on-the-late-topic"));
            await waitFor(() => received.includes("on-the-late-topic"), "the late topic discovered and consumed");
            assert.deepEqual(
                events.map((e) => e.type),
                ["connected"],
            );
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a callback that throws or rejects is reported once as lifecycle-error and does not stop publishing or consuming", { timeout: 60_000 }, async () => {
        const topic = await topicNamed(uniqueName("lc.throwing"));
        const failures: KafkaLifecycleEvent[] = [];
        const received: string[] = [];
        const adapter = newAdapter(async (event) => {
            if (event.type === "lifecycle-error") {
                failures.push(event);
                throw new Error("a failure while handling lifecycle-error is dropped");
            }
            throw new Error("rejected promise");
        });

        await adapter.connect();
        try {
            await waitFor(() => failures.length === 1, "the failure of the connected callback reported once");
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    received.push(text(event.payload));
                    await ack();
                },
                { group: uniqueName("group") },
            );
            await adapter.publish(topic, bytes("still-works"));
            await waitFor(() => received.includes("still-works"), "the message delivered although the callback rejected");
            const failure = failures[0] as Extract<KafkaLifecycleEvent, { type: "lifecycle-error" }>;
            assert.equal(failure.event, "connected");
            assert.equal(failure.callback, "onLifecycle");
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });
});

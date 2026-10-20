/**
 * A subscription pattern with an empty segment is refused before the Kafka adapter connects a
 * consumer, even when the call also lists an existing topic: no consumer joins the group.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real single-node broker.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import type { Admin } from "kafkajs";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;
const SCENARIO_TIMEOUT_MS = 90_000;

const uniqueName = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;

describe("Kafka adapter empty-segment rejection", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const kafka = new Kafka({ clientId: "empty-segment-control", brokers, logLevel: logLevel.ERROR });
    const admin: Admin = kafka.admin();
    const createdTopics: string[] = [];
    let adminConnected = false;

    async function ensureAdmin(): Promise<void> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
    }

    after(async () => {
        if (!adminConnected) {
            return;
        }
        try {
            if (createdTopics.length > 0) {
                await admin.deleteTopics({ topics: createdTopics });
            }
        } finally {
            await admin.disconnect();
        }
    });

    for (const [label, pattern] of [
        ["the empty string", ""],
        ["an empty segment between dots", "a..b"],
        ["a leading dot", ".a"],
        ["a trailing dot", "a."],
        ["a lone dot", "."],
    ] as const) {
        it(`subscribe() rejects ${label} and joins no consumer group`, { timeout: SCENARIO_TIMEOUT_MS }, async () => {
            await ensureAdmin();
            const topic = uniqueName("emptyseg");
            await createTopicWithLeader(admin, topic, 1);
            createdTopics.push(topic);
            const group = uniqueName("g");
            const adapter = KafkaAdapter({ brokers, clientId: uniqueName("emptyseg"), logLevel: "error" });
            await adapter.connect();
            try {
                await assert.rejects(
                    adapter.subscribe([topic, pattern], async () => undefined, { group }),
                    (error: unknown) => error instanceof TypeError && error.message.startsWith(`KafkaAdapter: subscription pattern "${pattern}" has an empty segment (`),
                );

                assert.equal(
                    (await admin.listGroups()).groups.some((g) => g.groupId === group),
                    false,
                    "no consumer of the rejected call joined its group",
                );
            } finally {
                await adapter.disconnect();
            }
        });
    }

    it("subscribe() still joins the group for an existing literal topic", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        await ensureAdmin();
        const topic = uniqueName("emptyseg");
        await createTopicWithLeader(admin, topic, 1);
        createdTopics.push(topic);
        const adapter = KafkaAdapter({ brokers, clientId: uniqueName("emptyseg"), logLevel: "error" });
        await adapter.connect();
        try {
            const subscription = await adapter.subscribe([topic], async () => undefined, { group: uniqueName("g") });
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });
});

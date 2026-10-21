/**
 * Kafka reserves the topic names "", "." and ".."; the adapter refuses them before it connects a
 * consumer, so no consumer joins the group. Every other name with an empty segment (`a..b`, `.a`,
 * `a.`) is a legal Kafka topic: a subscription to an existing one receives what is published to it.
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
const WAIT_TIMEOUT_MS = 30_000;

const uniqueName = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Kafka adapter topic names with an empty segment", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
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

    for (const pattern of ["", ".", ".."]) {
        it(`subscribe() rejects ${JSON.stringify(pattern)} and joins no consumer group`, { timeout: SCENARIO_TIMEOUT_MS }, async () => {
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
                    (error: unknown) => error instanceof TypeError && error.message === `KafkaAdapter: subscription pattern "${pattern}" is not a valid Kafka topic name. Kafka reserves the names "", "." and "..".`,
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

    for (const [label, build] of [
        ["an empty segment between dots", (id: string) => `${id}..b`],
        ["a leading dot", (id: string) => `.${id}`],
        ["a trailing dot", (id: string) => `${id}.`],
    ] as const) {
        it(`subscribes to an existing topic with ${label} and receives what is published to it`, { timeout: SCENARIO_TIMEOUT_MS }, async () => {
            await ensureAdmin();
            const topic = build(uniqueName("emptyseg"));
            await createTopicWithLeader(admin, topic, 1);
            createdTopics.push(topic);
            const adapter = KafkaAdapter({
                brokers,
                clientId: uniqueName("emptyseg"),
                logLevel: "error",
                consumerOptions: { fromBeginning: true, redeliveryDelay: 0 },
            });
            await adapter.connect();
            try {
                const received: string[] = [];
                const subscription = await adapter.subscribe(
                    [topic],
                    async (event, ack) => {
                        received.push(`${event.eventType}:${Buffer.from(event.payload).toString()}`);
                        await ack();
                    },
                    { group: uniqueName("g") },
                );
                await adapter.publish(topic, new Uint8Array(Buffer.from("hello")));

                const start = Date.now();
                while (received.length === 0) {
                    if (Date.now() - start > WAIT_TIMEOUT_MS) {
                        throw new Error("the event published to the topic did not arrive");
                    }
                    await sleep(100);
                }
                assert.deepEqual(received, [`${topic}:hello`]);
                await subscription.unsubscribe();
            } finally {
                await adapter.disconnect();
            }
        });
    }
});

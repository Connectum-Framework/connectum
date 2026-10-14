/**
 * Heartbeat cadence of a Kafka consumer whose handler runs for a long time, observed on the wire.
 *
 * Set KAFKA_TEST_URL to the bootstrap servers of a real single-node broker, e.g.
 * `localhost:19094`. The scenario creates its own topic and consumer group.
 *
 * The documented contract is a heartbeat every 3 seconds while a handler runs (the KafkaJS default
 * `heartbeatInterval`), checked twice per interval. KafkaJS refuses to send a heartbeat sooner than one
 * interval after the previous one, and the adapter's check runs every half interval, so two heartbeats
 * on the wire are never closer than 3 s and never further apart than 3 s plus one check period (4.5 s).
 * The wire is observed through the client's debug log, which records every request just before it is sent;
 * the existing membership test cannot tell a 3 s cadence from a 25 s one, because the group survives both.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const HANDLER_DURATION_MS = 14_000;
const INTERVAL_MS = 3_000;
/** One check period of the adapter (half an interval) on top of the interval itself. */
const LONGEST_GAP_MS = INTERVAL_MS + INTERVAL_MS / 2;
/** Timer and scheduling jitter allowed on top of the documented bounds. */
const JITTER_MS = 400;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(50);
    }
}

describe("Kafka heartbeat cadence during a long handler", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    it("the broker receives a heartbeat at least every 4.5 s and never more often than every 3 s while a handler runs", { timeout: 90_000 }, async () => {
        const brokers = (KAFKA_TEST_URL as string).split(",").map((broker) => broker.trim());
        const topic = `it.heartbeat-${randomUUID().replaceAll("-", "")}`;
        const group = `group-${randomUUID().replaceAll("-", "")}`;
        const admin = new Kafka({ clientId: "integration-heartbeat-control", brokers, logLevel: logLevel.ERROR }).admin();
        await admin.connect();

        // Every heartbeat request the client is about to send, with the time it was sent.
        const heartbeats: number[] = [];
        const adapter = KafkaAdapter({
            brokers,
            clientId: `integration-heartbeat-${randomUUID()}`,
            logLevel: "debug",
            clientOptions: {
                logCreator: () => (entry: { log: { message?: string } }) => {
                    if (typeof entry.log.message === "string" && entry.log.message.startsWith("Request Heartbeat(")) {
                        heartbeats.push(Date.now());
                    }
                },
            },
            consumerOptions: { fromBeginning: true, redeliveryDelay: 0 },
        });

        let handlerStartedAt = 0;
        let handlerEndedAt = 0;
        try {
            await createTopicWithLeader(admin, topic);
            await adapter.connect();
            const subscription = await adapter.subscribe(
                [topic],
                async (_event, ack) => {
                    handlerStartedAt = Date.now();
                    await sleep(HANDLER_DURATION_MS);
                    handlerEndedAt = Date.now();
                    await ack();
                },
                { group },
            );
            try {
                await adapter.publish(topic, new Uint8Array(Buffer.from("slow")));
                await waitFor(() => handlerEndedAt > 0, "the handler to finish", HANDLER_DURATION_MS + 30_000);
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
            await admin.disconnect().catch(() => undefined);
        }

        const during = heartbeats.filter((at) => at >= handlerStartedAt && at <= handlerEndedAt);
        // The last heartbeat before the handler started anchors the first gap; there is none when the handler started at once.
        const before = heartbeats.filter((at) => at < handlerStartedAt).at(-1);
        const timeline = [...(before === undefined ? [] : [before]), ...during];
        const gaps = timeline.slice(1).map((at, index) => at - (timeline[index] as number));

        // 14 s at one heartbeat per 3 to 4.5 s is three or four heartbeats; two is the least a conforming cadence can show.
        assert.ok(during.length >= 2, `a ${HANDLER_DURATION_MS} ms handler must be heartbeated at least twice (got ${during.length})`);
        assert.ok(
            during[0] !== undefined && during[0] - handlerStartedAt <= LONGEST_GAP_MS + JITTER_MS,
            `the first heartbeat must follow the start of the handler within ${LONGEST_GAP_MS} ms (got ${during[0] === undefined ? "none" : during[0] - handlerStartedAt} ms)`,
        );
        const lastBeat = during.at(-1) ?? 0;
        assert.ok(handlerEndedAt - lastBeat <= LONGEST_GAP_MS + JITTER_MS, `the handler must not end more than ${LONGEST_GAP_MS} ms after the last heartbeat (got ${handlerEndedAt - lastBeat} ms)`);
        for (const gap of gaps) {
            assert.ok(gap <= LONGEST_GAP_MS + JITTER_MS, `heartbeats must be at most ${LONGEST_GAP_MS} ms apart (gaps: ${JSON.stringify(gaps)})`);
            assert.ok(gap >= INTERVAL_MS - JITTER_MS, `heartbeats must be at least one interval apart (gaps: ${JSON.stringify(gaps)})`);
        }
    });
});

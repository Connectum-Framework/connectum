/**
 * The replacement of a crashed consumer must not race the client library's own restart.
 *
 * After a crash the library schedules a restart of the old consumer after `retryTime`. The adapter
 * confirms the deletion with a topic listing first; when that listing takes longer than the restart
 * delay, the old consumer is already starting when the adapter disconnects it, and a consumer that
 * is still starting ignores a stop. It then runs on beside its replacement, fails on the deleted
 * topic again and again, and each of its crashes is reported as a new loss.
 *
 * A very short retry time makes the library restart within milliseconds, so the window is wide
 * enough to hit on a local broker.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/WildcardRecoveryRace.integration.test.ts
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
        await sleep(50);
    }
}

describe("Kafka wildcard recovery against the client library's own restart", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const admin = new Kafka({ clientId: uniqueName("race-control"), brokers, logLevel: logLevel.NOTHING }).admin();
    let adminConnected = false;
    const adapters: ReturnType<typeof KafkaAdapter>[] = [];

    after(async () => {
        await Promise.allSettled(adapters.map((a) => a.disconnect()));
        if (adminConnected) {
            await admin.disconnect();
        }
    });

    for (let round = 1; round <= 1; round++) {
        it(`round ${round}: no consumer is left behind that keeps crashing after the replacement runs`, { timeout: 90_000 }, async () => {
            if (!adminConnected) {
                await admin.connect();
                adminConnected = true;
            }
            const prefix = uniqueName("race");
            const kept = `${prefix}.kept`;
            const doomed = `${prefix}.doomed`;
            await createTopicWithLeader(admin, kept);
            await createTopicWithLeader(admin, doomed);

            const events: KafkaLifecycleEvent[] = [];
            const received: string[] = [];
            const adapter = KafkaAdapter({
                brokers,
                clientId: uniqueName("race"),
                logLevel: "nothing",
                // Short enough that the library restarts the crashed consumer before the adapter's topic listing returns (a longer time does not hit the race on a local broker).
                retry: { initialRetryTime: 1, maxRetryTime: 2, retries: 1 },
                lifecycle: { onLifecycle: (event) => void events.push(event) },
                consumerOptions: { fromBeginning: true, redeliveryDelay: 0, topicDiscoveryInterval: false },
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

            await admin.deleteTopics({ topics: [doomed] });
            await publish(kept, "kept-after");
            await waitFor(() => received.includes("kept-after"), "the healthy topic delivers after the deletion", 45_000);
            await waitFor(() => events.some((e) => e.type === "consumer-restored"), "consumer-restored is reported", 15_000);

            // A leftover consumer of the old incarnation crashes about once a second; look for it for a while.
            const settled = events.length;
            await sleep(6_000);
            const after = events.slice(settled).map((e) => e.type);
            assert.deepEqual(after, [], `no further crash reports after the recovery settled: ${after.join(", ")}`);
            await subscription.unsubscribe();
        });
    }
});

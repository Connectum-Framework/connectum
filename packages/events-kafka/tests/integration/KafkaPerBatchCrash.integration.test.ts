/**
 * Death of a consumer between `ack()` and the end of a batch under `commitStrategy: "per-batch"`.
 *
 * Set KAFKA_TEST_URL to the bootstrap servers of a real single-node broker, e.g. `localhost:19094`.
 *
 * Documented contract: with `"per-batch"` an acknowledgement is not durable until the batch ends. If
 * the process dies in between, every message acknowledged in that batch is delivered again to the next
 * consumer of the group, and none is lost. The death is real: a child process is killed with SIGKILL,
 * so no shutdown path of the adapter gets a chance to flush the pending commit.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const MESSAGE_COUNT = 10;
const ACKED_BEFORE_DEATH = 5;
const VICTIM = fileURLToPath(new URL("./perBatchVictim.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(100);
    }
}

describe("Kafka per-batch commit strategy: death of the consumer in the middle of a batch", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    it("every message acknowledged but not yet committed is delivered again to the next consumer of the group, and none is lost", { timeout: 120_000 }, async () => {
        const brokers = (KAFKA_TEST_URL as string).split(",").map((broker) => broker.trim());
        const topic = `it.per-batch-crash-${randomUUID().replaceAll("-", "")}`;
        const group = `group-${randomUUID().replaceAll("-", "")}`;
        const payloads = Array.from({ length: MESSAGE_COUNT }, (_, index) => `message-${String(index).padStart(2, "0")}`);
        const admin = new Kafka({ clientId: "integration-per-batch-control", brokers, logLevel: logLevel.ERROR }).admin();
        await admin.connect();

        const committedOffset = async (): Promise<number> => {
            const [entry] = await admin.fetchOffsets({ groupId: group, topics: [topic] });
            return Number(entry?.partitions.find((partition) => partition.partition === 0)?.offset ?? -1);
        };

        let victim: ChildProcess | undefined;
        // Publisher only; its consumer side is never used.
        const producer = KafkaAdapter({ brokers, clientId: `per-batch-publisher-${randomUUID()}`, logLevel: "error" });
        try {
            await createTopicWithLeader(admin, topic);
            // All messages exist before the consumer starts, so it fetches them as one batch.
            await producer.connect();
            for (const payload of payloads) {
                await producer.publish(topic, new Uint8Array(Buffer.from(payload)), { key: "same-partition" });
            }

            victim = spawn(process.execPath, [VICTIM], {
                env: { ...process.env, KAFKA_TEST_URL: brokers.join(","), TOPIC: topic, GROUP: group, ACKS: String(ACKED_BEFORE_DEATH) },
                stdio: ["ignore", "pipe", "inherit"],
            });
            let victimOutput = "";
            victim.stdout?.on("data", (chunk: Buffer) => {
                victimOutput += chunk.toString();
            });
            await waitFor(() => victimOutput.includes("READY"), "the consumer to acknowledge five messages and block on the sixth", 60_000);

            // The acknowledgements exist only in the child; nothing may have reached the broker yet.
            assert.equal(await committedOffset(), -1, "a per-batch consumer must not commit before the batch ends");

            const exited = once(victim, "exit");
            victim.kill("SIGKILL");
            await exited;
            assert.equal(await committedOffset(), -1, "a killed consumer leaves the group with nothing committed");

            // The next consumer of the group takes the partition over once the dead member's session expires.
            const received: string[] = [];
            const successor = KafkaAdapter({
                brokers,
                clientId: `per-batch-successor-${randomUUID()}`,
                logLevel: "error",
                consumerOptions: { fromBeginning: true, sessionTimeout: 6_000, commitStrategy: "per-batch", redeliveryDelay: 0 },
            });
            await successor.connect();
            try {
                const subscription = await successor.subscribe(
                    [topic],
                    async (event, ack) => {
                        received.push(Buffer.from(event.payload).toString());
                        await ack();
                    },
                    { group },
                );
                try {
                    await waitFor(() => received.length >= MESSAGE_COUNT, "the successor to receive the whole batch", 60_000);
                    await waitFor(async () => (await committedOffset()) === MESSAGE_COUNT, "the successor to commit the batch", 20_000);
                } finally {
                    await subscription.unsubscribe();
                }
            } finally {
                await successor.disconnect();
            }

            assert.deepEqual(received.slice(0, MESSAGE_COUNT), payloads, "all ten messages, the five acknowledged by the dead consumer included, arrive again in order");
        } finally {
            if (victim !== undefined && victim.exitCode === null && victim.signalCode === null) {
                victim.kill("SIGKILL");
            }
            await producer.disconnect().catch(() => undefined);
            await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
            await admin.disconnect().catch(() => undefined);
        }
    });
});

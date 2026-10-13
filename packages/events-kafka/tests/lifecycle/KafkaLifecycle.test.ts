/**
 * Lifecycle events of the Kafka adapter against a real broker.
 *
 * Set KAFKA_TEST_URL to the bootstrap address of a broker that runs in Docker with its port published
 * (the suite finds the container by that port and freezes it with `docker pause`), e.g.:
 *
 *   KAFKA_LIFECYCLE_TESTS=1 KAFKA_TEST_URL=localhost:19094 pnpm exec exodus-test --typescript tests/lifecycle/KafkaLifecycle.test.ts
 *
 * It is not part of the CI suite. It lives outside tests/integration and runs only with KAFKA_LIFECYCLE_TESTS=1: a
 * frozen broker would fail whatever runs beside it, and about one run in three leaves a socket open after the tests
 * passed (a connection the client library opens while a restarted consumer is stopped), so the process does not exit
 * on its own. The mapping itself is covered by unit tests of the tracker and, in CI, by tests/integration/KafkaLifecycle.integration.test.ts.
 *
 * Freezing the broker makes the consumer's requests time out until the client's retries run out, which
 * is when KafkaJS reports `CRASH`; unfreezing lets the restarted consumer join its group again
 * (`GROUP_JOIN`). The oracle for those two moments is the consumer events documented by KafkaJS.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import type { EventAdapter } from "@connectum/events";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import type { KafkaLifecycleEvent } from "../../src/types.ts";
import { createTopicWithLeader } from "../integration/createTopic.ts";

const exec = promisify(execFile);
const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (!(await cond())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
        }
        await sleep(100);
    }
}

function uniqueName(prefix: string): string {
    return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}

const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "utf-8"));
const text = (value: Uint8Array): string => Buffer.from(value).toString("utf-8");

describe("Kafka adapter lifecycle events", { skip: KAFKA_TEST_URL === undefined || process.env.KAFKA_LIFECYCLE_TESTS !== "1" ? "KAFKA_TEST_URL or KAFKA_LIFECYCLE_TESTS=1 not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const publishedPort = brokers[0]?.split(":").at(-1) ?? "9092";
    const admin = new Kafka({ clientId: uniqueName("lifecycle-control"), brokers, logLevel: logLevel.NOTHING }).admin();
    let adminConnected = false;

    after(async () => {
        if (adminConnected) {
            await admin.disconnect();
        }
    });

    async function brokerContainer(): Promise<string> {
        const { stdout } = await exec("docker", ["ps", "--filter", `publish=${publishedPort}`, "--format", "{{.ID}}"]);
        const id = stdout.split("\n")[0]?.trim();
        if (!id) {
            throw new Error(`no running container publishes port ${publishedPort}; this suite needs the broker to run in Docker`);
        }
        return id;
    }

    /**
     * Let a restarted consumer finish a whole fetch cycle (KafkaJS long-polls for up to 5 s) before it is stopped.
     * Stopping it in the middle of the cycle that follows a crash restart can leave one socket opened by the
     * client library after its own disconnect, which keeps the test process alive; this is the client library's
     * race, not something the adapter can close.
     */
    async function settle(): Promise<void> {
        await sleep(6_000);
    }


    async function topicFor(prefix: string): Promise<string> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
        const name = uniqueName(prefix);
        await createTopicWithLeader(admin, name);
        return name;
    }

    /** An adapter whose client gives up quickly, so a frozen broker ends in a crash within seconds. */
    function newAdapter(onLifecycle: (event: KafkaLifecycleEvent) => void | Promise<void>): EventAdapter {
        return KafkaAdapter({
            brokers,
            clientId: uniqueName("lifecycle"),
            logLevel: "nothing",
            connectionTimeout: 1_000,
            requestTimeout: 2_000,
            retry: { retries: 1, initialRetryTime: 100, maxRetryTime: 500 },
            consumerOptions: { fromBeginning: true, redeliveryDelay: 0, sessionTimeout: 6_000, topicDiscoveryInterval: 1_000 },
            lifecycle: { onLifecycle },
        });
    }

    /** Freeze the broker until `condition` holds, and always unfreeze it. */
    async function withFrozenBroker(condition: () => boolean, label: string): Promise<void> {
        const id = await brokerContainer();
        await exec("docker", ["pause", id]);
        try {
            await waitFor(condition, label);
        } finally {
            await exec("docker", ["unpause", id]);
        }
    }

    it("reports the producer's connect once, then a crashed consumer and its return to the group, and nothing for an orderly unsubscribe", { timeout: 180_000 }, async () => {
        const topic = await topicFor("lc.crash");
        const group = uniqueName("group");
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
                { group },
            );
            await adapter.publish(topic, bytes("before"));
            await waitFor(() => received.includes("before"), "the consumer delivers before the freeze");
            assert.equal(
                events.some((e) => e.type.startsWith("consumer-")),
                false,
                "a consumer that joined its group for the first time reports nothing",
            );

            await withFrozenBroker(() => events.some((e) => e.type === "consumer-lost"), "the crash of the consumer");
            await waitFor(() => events.some((e) => e.type === "consumer-restored"), "the consumer back in its group");

            const lost = events.filter((e) => e.type === "consumer-lost");
            assert.equal(lost.length, 1, "one loss, however long the broker was away");
            const first = lost[0] as Extract<KafkaLifecycleEvent, { type: "consumer-lost" }>;
            assert.equal(first.groupId, group);
            assert.equal(first.willRestore, true);
            assert.ok(first.error instanceof Error);
            const restored = events.filter((e) => e.type === "consumer-restored") as Extract<KafkaLifecycleEvent, { type: "consumer-restored" }>[];
            assert.equal(restored.length, 1);
            assert.equal(restored[0]?.groupId, group);
            const order = events.map((e) => e.type).filter((t) => t !== "consumer-restore-failed");
            assert.deepEqual(order, ["connected", "consumer-lost", "consumer-restored"]);

            await adapter.publish(topic, bytes("after"));
            await waitFor(() => received.includes("after"), "the restarted consumer delivers again");

            const before = events.length;
            await settle();
            await subscription.unsubscribe();
            await adapter.disconnect();
            await sleep(500);
            assert.equal(events.length, before, "our own unsubscribe and disconnect report nothing");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a callback that throws on a crash does not stop the client from restarting the consumer", { timeout: 180_000 }, async () => {
        const topic = await topicFor("lc.throwing");
        const group = uniqueName("group");
        const failures: KafkaLifecycleEvent[] = [];
        const all: KafkaLifecycleEvent[] = [];
        const received: string[] = [];
        const adapter = newAdapter((event) => {
            all.push(event);
            if (event.type === "lifecycle-error") {
                failures.push(event);
                throw new Error("a failure while handling lifecycle-error is dropped");
            }
            throw new Error("synchronous failure");
        });

        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    received.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            await adapter.publish(topic, bytes("before"));
            await waitFor(() => received.includes("before"), "the consumer delivers before the freeze");

            await withFrozenBroker(() => all.some((e) => e.type === "consumer-lost"), "the crash of the consumer");
            await waitFor(() => all.some((e) => e.type === "consumer-restored"), "the consumer back in its group although the callback threw");
            await adapter.publish(topic, bytes("after"));
            await waitFor(() => received.includes("after"), "the restarted consumer delivers again");

            assert.ok(failures.length >= 2, "the failures of the callback were reported");
            assert.ok(failures.every((e) => e.type === "lifecycle-error" && e.callback === "onLifecycle"));
            await settle();
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });
});

/**
 * Kafka broker integration coverage.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real
 * single-node broker, e.g.:
 *
 *   docker run -d --name connectum-kafka-test -p 9092:9092 apache/kafka:4.2.0
 *   KAFKA_TEST_URL=localhost:9092 pnpm --filter @connectum/events-kafka test:integration
 *
 * Every scenario creates its own uniquely named topics and consumer groups, so
 * scenarios do not depend on each other or on leftovers of an earlier run.
 * Topics are created up front: the adapter does not create topics by default,
 * and a consumer subscribing to a missing topic is not retried by kafkajs.
 *
 * Consumers start from the beginning of the topic wherever a scenario publishes
 * right after subscribing. `subscribe()` resolves before the group join has
 * finished, so with the default "latest" start position such a message could be
 * published before the consumer owns its partition and would never be seen.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import type { EventAdapter, RawEvent } from "@connectum/events";
import { createEventContext, dlqMiddleware } from "@connectum/events";
import type { Admin } from "kafkajs";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const SCENARIO_TIMEOUT_MS = 90_000;
const WAIT_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `cond` until it returns true; on timeout fail with `label` and the state `observed` reports. */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, observed?: () => unknown, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    while (!(await cond())) {
        if (Date.now() - start > timeoutMs) {
            const state = observed === undefined ? "" : `; observed: ${JSON.stringify(await observed())}`;
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms${state}`);
        }
        await sleep(100);
    }
}

function uniqueName(prefix: string): string {
    return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}

function text(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("utf-8");
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "utf-8"));
}

describe("Kafka adapter broker integration", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const kafkaConfig = { logLevel: logLevel.ERROR } as const;
    const kafka = new Kafka({ clientId: "integration-control", brokers, logLevel: logLevel.ERROR });
    const admin: Admin = kafka.admin();
    const createdTopics: string[] = [];
    let adminConnected = false;

    async function ensureAdmin(): Promise<void> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
    }

    async function createTopic(name: string, partitions = 1): Promise<string> {
        await ensureAdmin();
        const created = await admin.createTopics({
            waitForLeaders: true,
            topics: [{ topic: name, numPartitions: partitions, replicationFactor: 1 }],
        });
        assert.equal(created, true, `topic ${name} was not created`);
        createdTopics.push(name);
        return name;
    }

    /**
     * Adapter for one scenario. A positive redelivery pause costs a whole KafkaJS fetch cycle (5 s)
     * per redelivery on an idle consumer, so scenarios that are not about pacing redeliver at once
     * (`redeliveryDelay: 0`); `adapterDefaultRedelivery` leaves the option unset to exercise the default.
     */
    function newAdapter(extra?: { fromBeginning?: boolean; redeliveryDelay?: number; adapterDefaultRedelivery?: boolean; sessionTimeout?: number }): EventAdapter {
        return KafkaAdapter({
            brokers,
            clientId: uniqueName("integration"),
            kafkaConfig,
            consumerOptions: {
                fromBeginning: extra?.fromBeginning ?? true,
                ...(extra?.sessionTimeout !== undefined && { sessionTimeout: extra.sessionTimeout }),
                ...(extra?.adapterDefaultRedelivery !== true && { redeliveryDelay: extra?.redeliveryDelay ?? 0 }),
            },
        });
    }

    /** Committed offset of `groupId` on partition 0 of `topic` (-1 when nothing is committed). */
    async function committedOffset(groupId: string, topic: string): Promise<number> {
        await ensureAdmin();
        const [entry] = await admin.fetchOffsets({ groupId, topics: [topic] });
        const partition = entry?.partitions.find((p) => p.partition === 0);
        return Number(partition?.offset ?? -1);
    }

    async function groupMembers(groupId: string): Promise<{ members: number; state: string }> {
        await ensureAdmin();
        const { groups } = await admin.describeGroups([groupId]);
        const group = groups[0];
        return { members: group?.members.length ?? 0, state: group?.state ?? "Unknown" };
    }

    async function waitForStableGroup(groupId: string, members: number): Promise<void> {
        await waitFor(async () => {
            const g = await groupMembers(groupId);
            return g.members === members && g.state === "Stable";
        }, `group ${groupId} stable with ${members} member(s)`);
    }

    after(async () => {
        if (!adminConnected) {
            return;
        }
        try {
            await admin.deleteTopics({ topics: createdTopics });
        } finally {
            await admin.disconnect();
        }
    });

    it("roundtrip: payload bytes, key, metadata and generated fields reach the handler", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.roundtrip"));
        const group = uniqueName("group");
        const payload = new Uint8Array([0, 1, 2, 127, 128, 253, 254, 255]);
        const received: RawEvent[] = [];
        const adapter = newAdapter();

        await adapter.connect({ serviceName: "integration-roundtrip" });
        try {
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    received.push(event);
                    await ack();
                },
                { group },
            );
            try {
                const before = Date.now();
                await adapter.publish(topic, payload, { key: "order-42", metadata: { "trace-id": "trace-123", "tenant": "acme" } });
                await waitFor(() => received.length === 1, "one event delivered");

                const [event] = received;
                assert.ok(event);
                assert.equal(event.eventType, topic);
                assert.deepEqual(event.payload, payload);
                assert.equal(event.metadata.get("trace-id"), "trace-123");
                assert.equal(event.metadata.get("tenant"), "acme");
                assert.equal(event.metadata.has("x-event-id"), false, "internal id header must not leak into metadata");
                assert.equal(event.metadata.has("x-published-at"), false, "internal timestamp header must not leak into metadata");
                assert.match(event.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                assert.equal(event.attempt, 1);
                assert.ok(event.publishedAt.getTime() >= before - 1_000, "publishedAt is the publish time");
                assert.ok(event.publishedAt.getTime() <= Date.now() + 1_000);

                await waitFor(async () => (await committedOffset(group, topic)) === 1, "offset 1 committed after ack", async () => ({ committed: await committedOffset(group, topic) }));
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it(
        "a handler that outlives the session timeout keeps its membership: the message is delivered once and committed",
        { timeout: SCENARIO_TIMEOUT_MS },
        async () => {
            const topic = await createTopic(uniqueName("it.long-handler"));
            const group = uniqueName("group");
            const sessionTimeout = 10_000;
            const handlerDuration = 25_000;

            const deliveries: string[] = [];
            let ackSucceeded = false;
            const adapter = newAdapter({ sessionTimeout });
            await adapter.connect();
            try {
                const subscription = await adapter.subscribe(
                    [topic],
                    async (event, ack) => {
                        deliveries.push(text(event.payload));
                        await sleep(handlerDuration);
                        await ack();
                        ackSucceeded = true;
                    },
                    { group },
                );
                try {
                    await adapter.publish(topic, bytes("slow"));
                    await waitFor(() => deliveries.length === 1, "message delivered");
                    await waitForStableGroup(group, 1);
                    await waitFor(() => ackSucceeded, "ack accepted", () => ({ deliveries: deliveries.length }), handlerDuration + WAIT_TIMEOUT_MS);
                    await waitFor(
                        async () => (await committedOffset(group, topic)) === 1,
                        "offset 1 committed",
                        async () => ({ committed: await committedOffset(group, topic), deliveries: deliveries.length }),
                    );
                    await sleep(2_000);
                    assert.deepEqual(deliveries, ["slow"], "the message must be delivered exactly once");
                    assert.equal(await committedOffset(group, topic), 1);
                } finally {
                    await subscription.unsubscribe();
                }
            } finally {
                await adapter.disconnect();
            }
        },
    );

    it("user metadata cannot spoof the internal event id",{ timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.spoof"));
        const received: RawEvent[] = [];
        const adapter = newAdapter();

        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    received.push(event);
                    await ack();
                },
                { group: uniqueName("group") },
            );
            try {
                await adapter.publish(topic, bytes("x"), { metadata: { "x-event-id": "forged-id" } });
                await waitFor(() => received.length === 1, "one event delivered");
                assert.notEqual(received[0]?.eventId, "forged-id");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("ack commits the offset: an acked message is not redelivered to the same group", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.ack"));
        const group = uniqueName("group");

        const first: string[] = [];
        const adapter1 = newAdapter();
        await adapter1.connect();
        try {
            const subscription = await adapter1.subscribe(
                [topic],
                async (event, ack) => {
                    first.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await adapter1.publish(topic, bytes("one"));
                await waitFor(() => first.length === 1, "first message delivered");
                await waitFor(async () => (await committedOffset(group, topic)) === 1, "offset 1 committed", async () => ({ committed: await committedOffset(group, topic) }));
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter1.disconnect();
        }

        const second: string[] = [];
        const adapter2 = newAdapter();
        await adapter2.connect();
        try {
            const subscription = await adapter2.subscribe(
                [topic],
                async (event, ack) => {
                    second.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await adapter2.publish(topic, bytes("two"));
                await waitFor(() => second.length >= 1, "second message delivered");
                await sleep(1_000);
                assert.deepEqual(second, ["two"], "the acked message must not come back");
                await waitFor(async () => (await committedOffset(group, topic)) === 2, "offset 2 committed");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter2.disconnect();
        }
    });

    it("messages published while the group is stopped arrive exactly once after restart, with the default start position", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.idle-gap"));
        const group = uniqueName("group");
        const before = ["before-1", "before-2", "before-3"];
        const duringIdle = ["idle-1", "idle-2"];

        const first: string[] = [];
        const adapter1 = newAdapter({ fromBeginning: false });
        await adapter1.connect();
        try {
            const subscription = await adapter1.subscribe(
                [topic],
                async (event, ack) => {
                    first.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitForStableGroup(group, 1);
                for (const value of before) {
                    await adapter1.publish(topic, bytes(value));
                }
                await waitFor(async () => (await committedOffset(group, topic)) === before.length, "offset after the first run committed", async () => ({ committed: await committedOffset(group, topic), first }));
            } finally {
                await subscription.unsubscribe();
            }

            // The consumer is gone; these arrive while nobody in the group is listening.
            for (const value of duringIdle) {
                await adapter1.publish(topic, bytes(value));
            }
        } finally {
            await adapter1.disconnect();
        }
        assert.deepEqual(first, before);

        const second: string[] = [];
        const adapter2 = newAdapter({ fromBeginning: false });
        await adapter2.connect();
        try {
            const subscription = await adapter2.subscribe(
                [topic],
                async (event, ack) => {
                    second.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => second.length >= duringIdle.length, "messages published during the gap delivered", () => ({ second }));
                await sleep(1_000);
                assert.deepEqual(second, duringIdle, "exactly the messages of the gap: none lost, none repeated");
                await waitFor(async () => (await committedOffset(group, topic)) === before.length + duringIdle.length, "offset covers the gap messages");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter2.disconnect();
        }
    });

    it("a throwing handler stops the batch and the same message is redelivered before later ones, after the default pause",{ timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.redeliver-throw"));
        const group = uniqueName("group");
        const deliveries: { payload: string; eventId: string; at: number }[] = [];
        const adapter = newAdapter({ adapterDefaultRedelivery: true });
        let failedOnce = false;

        await adapter.connect();
        try {
            // Publish all three before subscribing so they arrive as one batch.
            await adapter.publish(topic, bytes("m1"));
            await adapter.publish(topic, bytes("m2"));
            await adapter.publish(topic, bytes("m3"));

            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    deliveries.push({ payload: text(event.payload), eventId: event.eventId, at: Date.now() });
                    if (text(event.payload) === "m2" && !failedOnce) {
                        failedOnce = true;
                        throw new Error("handler failure");
                    }
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => deliveries.filter((d) => d.payload === "m3").length >= 1, "m3 delivered", () => ({ deliveries: deliveries.map((d) => d.payload) }));

                assert.deepEqual(
                    deliveries.map((d) => d.payload),
                    ["m1", "m2", "m2", "m3"],
                    "m1 acked once, m2 retried in place, m3 only after m2 succeeded",
                );
                const m2 = deliveries.filter((d) => d.payload === "m2");
                assert.equal(m2[0]?.eventId, m2[1]?.eventId, "a redelivery carries the same event id");
                const gap = (m2[1]?.at ?? 0) - (m2[0]?.at ?? 0);
                assert.ok(gap >= 950, `m2 came back ${gap}ms after the failure, expected at least the default 1000ms pause`);
                await waitFor(async () => (await committedOffset(group, topic)) === 3, "offset 3 committed once all are acked", async () => ({ committed: await committedOffset(group, topic) }));
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("nack() requeues the message; nack(false) commits it and moves on", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.nack"));
        const group = uniqueName("group");
        const deliveries: string[] = [];
        const adapter = newAdapter();
        let requeued = false;

        await adapter.connect();
        try {
            await adapter.publish(topic, bytes("a"));
            await adapter.publish(topic, bytes("b"));
            await adapter.publish(topic, bytes("c"));

            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack, nack) => {
                    const value = text(event.payload);
                    deliveries.push(value);
                    if (value === "a" && !requeued) {
                        requeued = true;
                        await nack();
                        return;
                    }
                    if (value === "b") {
                        await nack(false);
                        return;
                    }
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => deliveries.includes("c"), "c delivered", () => ({ deliveries }));
                await waitFor(async () => (await committedOffset(group, topic)) === 3, "offset 3 committed", async () => ({ committed: await committedOffset(group, topic) }));

                assert.deepEqual(deliveries, ["a", "a", "b", "c"], "a is requeued once, b is dropped after nack(false), b is never redelivered");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("mixed batch: ack, nack(false), a throw and a requeue are settled in order and nothing after an open message is skipped", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.mixed"));
        const group = uniqueName("group");
        const deliveries: string[] = [];
        const adapter = newAdapter();
        const seen = new Set<string>();

        await adapter.connect();
        try {
            for (const value of ["m1", "m2", "m3", "m4", "m5"]) {
                await adapter.publish(topic, bytes(value));
            }

            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack, nack) => {
                    const value = text(event.payload);
                    deliveries.push(value);
                    const firstTime = !seen.has(value);
                    seen.add(value);
                    if (value === "m2") {
                        await nack(false);
                    } else if (value === "m3" && firstTime) {
                        throw new Error("handler failure");
                    } else if (value === "m4" && firstTime) {
                        await nack(true);
                    } else {
                        await ack();
                    }
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 5, "offset 5 committed", async () => ({ committed: await committedOffset(group, topic), deliveries }));

                assert.deepEqual(deliveries, ["m1", "m2", "m3", "m3", "m4", "m4", "m5"], "m2 is dropped once, m3 and m4 are retried in place before m5");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("restart after a partial batch: the new consumer of the group resumes at the first unsettled message, in order", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.restart-partial"));
        const group = uniqueName("group");
        const firstRun: string[] = [];
        const adapter1 = newAdapter();

        await adapter1.connect();
        try {
            for (const value of ["m1", "m2", "m3", "m4"]) {
                await adapter1.publish(topic, bytes(value));
            }
            const subscription = await adapter1.subscribe(
                [topic],
                async (event, ack) => {
                    const value = text(event.payload);
                    firstRun.push(value);
                    if (value === "m1" || value === "m2") {
                        await ack();
                    }
                    // m3 returns without settling: nothing at or after it may be committed.
                },
                { group },
            );
            try {
                await waitFor(() => firstRun.includes("m3"), "m3 delivered and left open", () => ({ firstRun }));
                await waitFor(async () => (await committedOffset(group, topic)) === 2, "offset 2 committed", async () => ({ committed: await committedOffset(group, topic) }));
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter1.disconnect();
        }
        assert.equal(await committedOffset(group, topic), 2, "m3 and m4 must stay uncommitted");

        const secondRun: string[] = [];
        const adapter2 = newAdapter();
        await adapter2.connect();
        try {
            const subscription = await adapter2.subscribe(
                [topic],
                async (event, ack) => {
                    secondRun.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 4, "offset 4 committed", async () => ({ committed: await committedOffset(group, topic), secondRun }));
                assert.deepEqual(secondRun, ["m3", "m4"], "acked messages stay acked; the open one and the rest come back in order");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter2.disconnect();
        }
    });

    it("an ack that arrives after the handler returned does not commit anything", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.late-ack"));
        const group = uniqueName("group");
        const adapter = newAdapter({ redeliveryDelay: 1_500 });
        let lateAck: (() => Promise<void>) | undefined;
        const deliveries: string[] = [];

        await adapter.connect();
        try {
            await adapter.publish(topic, bytes("x"));
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    deliveries.push(text(event.payload));
                    if (lateAck === undefined) {
                        // First delivery: return without settling and keep the ack for later.
                        lateAck = ack;
                        return;
                    }
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => lateAck !== undefined, "first delivery observed");
                await lateAck?.();
                assert.equal(await committedOffset(group, topic), -1, "a late ack of an abandoned delivery must not commit");

                await waitFor(() => deliveries.length >= 2, "message redelivered after the delay", () => ({ deliveries }));
                await waitFor(async () => (await committedOffset(group, topic)) === 1, "offset 1 committed by the redelivery's own ack");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("redeliveryDelay spaces out redeliveries of an unsettled message instead of a tight loop", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.delay"));
        const group = uniqueName("group");
        const delay = 500;
        const adapter = newAdapter({ redeliveryDelay: delay });
        const stamps: number[] = [];

        await adapter.connect();
        try {
            await adapter.publish(topic, bytes("poison"));
            const subscription = await adapter.subscribe(
                [topic],
                async () => {
                    stamps.push(Date.now());
                    throw new Error("always failing");
                },
                { group },
            );
            try {
                await waitFor(() => stamps.length >= 3, "three deliveries", () => ({ stamps }), 30_000);
                for (let i = 1; i < stamps.length; i++) {
                    const gap = (stamps[i] as number) - (stamps[i - 1] as number);
                    assert.ok(gap >= delay - 50, `delivery ${i + 1} came ${gap}ms after the previous one, expected at least ~${delay}ms`);
                }
                assert.equal(await committedOffset(group, topic), -1, "nothing is committed while the handler keeps failing");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("unsubscribe in the middle of a batch: the message being handled is settled, the rest stays for the next consumer", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.stop-mid-batch"));
        const group = uniqueName("group");
        const firstRun: string[] = [];
        const adapter1 = newAdapter();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let m2Started = false;

        await adapter1.connect();
        try {
            for (const value of ["m1", "m2", "m3"]) {
                await adapter1.publish(topic, bytes(value));
            }
            const subscription = await adapter1.subscribe(
                [topic],
                async (event, ack) => {
                    const value = text(event.payload);
                    firstRun.push(value);
                    if (value === "m2") {
                        m2Started = true;
                        await gate;
                    }
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => m2Started, "m2 is being handled", () => ({ firstRun }));
                const stopping = subscription.unsubscribe();
                await sleep(300);
                release?.();
                await stopping;
            } finally {
                release?.();
            }
        } finally {
            await adapter1.disconnect();
        }
        assert.deepEqual(firstRun, ["m1", "m2"], "m3 must not start after the consumer was told to stop");
        const committed = await committedOffset(group, topic);
        assert.ok(committed === 2 || committed === 1, `committed offset must cover m1 and possibly m2, got ${committed}`);

        const secondRun: string[] = [];
        const adapter2 = newAdapter();
        await adapter2.connect();
        try {
            const subscription = await adapter2.subscribe(
                [topic],
                async (event, ack) => {
                    secondRun.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 3, "offset 3 committed", async () => ({ committed: await committedOffset(group, topic), secondRun }));
                assert.equal(secondRun.at(-1), "m3", "m3 is delivered to the next consumer");
                assert.ok(!secondRun.includes("m1"), "m1 was acked and must not come back");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter2.disconnect();
        }
    });

    it("a message that was never acked is redelivered to a new consumer of the group",{ timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.unacked"));
        const group = uniqueName("group");
        const firstSeen: string[] = [];
        const adapter1 = newAdapter();

        await adapter1.connect();
        try {
            await adapter1.publish(topic, bytes("pending"));
            const subscription = await adapter1.subscribe(
                [topic],
                async (event) => {
                    // Receives the message but neither acks nor nacks: nothing is committed.
                    firstSeen.push(text(event.payload));
                },
                { group },
            );
            try {
                await waitFor(() => firstSeen.length >= 1, "message delivered to the first consumer");            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter1.disconnect();
        }
        assert.equal(await committedOffset(group, topic), -1, "no offset may be committed without an ack");

        const secondSeen: string[] = [];
        const adapter2 = newAdapter();
        await adapter2.connect();
        try {
            const subscription = await adapter2.subscribe(
                [topic],
                async (event, ack) => {
                    secondSeen.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => secondSeen.length >= 1, "message redelivered to the second consumer");
                assert.equal(secondSeen[0], "pending");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter2.disconnect();
        }
    });

    it("default start position is the end of the topic: earlier messages are not delivered", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.latest"));
        const group = uniqueName("group");
        const received: string[] = [];
        const adapter = newAdapter({ fromBeginning: false });

        await adapter.connect();
        try {
            await adapter.publish(topic, bytes("old"));
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    received.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitForStableGroup(group, 1);
                await adapter.publish(topic, bytes("new"));
                await waitFor(() => received.length >= 1, "message published after the join delivered");
                await sleep(500);
                assert.deepEqual(received, ["new"]);
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("wildcard subscriptions match live topics: * is one segment, > is one or more", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const root = uniqueName("it.wild");
        const created = await Promise.all([createTopic(`${root}.a.created`), createTopic(`${root}.b.created`), createTopic(`${root}.a.b.created`), createTopic(`${root}.a.deleted`)]);
        const [aCreated, bCreated, abCreated, aDeleted] = created as [string, string, string, string];

        const starSeen = new Set<string>();
        const gtSeen = new Set<string>();
        const adapter = newAdapter();

        await adapter.connect();
        try {
            const star = await adapter.subscribe(
                [`${root}.*.created`],
                async (event, ack) => {
                    starSeen.add(event.eventType);
                    await ack();
                },
                { group: uniqueName("group") },
            );
            const gt = await adapter.subscribe(
                [`${root}.>`],
                async (event, ack) => {
                    gtSeen.add(event.eventType);
                    await ack();
                },
                { group: uniqueName("group") },
            );
            try {
                for (const topic of [aCreated, bCreated, abCreated, aDeleted]) {
                    await adapter.publish(topic, bytes(topic));
                }

                await waitFor(() => gtSeen.size === 4, "the > subscription saw all four topics");
                await waitFor(() => starSeen.size >= 2, "the * subscription saw its two topics");
                await sleep(1_000);

                assert.deepEqual([...starSeen].sort(), [aCreated, bCreated].sort(), "* must not match a.b.created nor a.deleted");
                assert.deepEqual([...gtSeen].sort(), [aCreated, bCreated, abCreated, aDeleted].sort());
            } finally {
                await star.unsubscribe();
                await gt.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("consumer group: partitions are shared, each message is delivered once, and a leaving member's partitions move to the survivor", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.rebalance"), 2);
        const group = uniqueName("group");
        const seenByA: string[] = [];
        const seenByB: string[] = [];
        const adapterA = newAdapter();
        const adapterB = newAdapter();

        await adapterA.connect();
        await adapterB.connect();
        try {
            const subA = await adapterA.subscribe(
                [topic],
                async (event, ack) => {
                    seenByA.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            await waitForStableGroup(group, 1);

            const subB = await adapterB.subscribe(
                [topic],
                async (event, ack) => {
                    seenByB.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            let bLeft = false;
            try {
                await waitForStableGroup(group, 2);

                const firstWave = Array.from({ length: 20 }, (_, i) => `wave1-${i}`);
                for (const [i, value] of firstWave.entries()) {
                    await adapterA.publish(topic, bytes(value), { key: `key-${i}` });
                }
                await waitFor(() => seenByA.length + seenByB.length >= firstWave.length, "first wave delivered");
                await sleep(1_000);

                const all = [...seenByA, ...seenByB];
                assert.equal(all.length, firstWave.length, "no duplicates inside the group");
                assert.deepEqual([...all].sort(), [...firstWave].sort(), "no message lost");
                assert.ok(seenByA.length > 0 && seenByB.length > 0, `both members must own a partition (A=${seenByA.length}, B=${seenByB.length})`);

                await subB.unsubscribe();
                bLeft = true;
                await waitForStableGroup(group, 1);

                const bAfterLeave = seenByB.length;
                const secondWave = Array.from({ length: 20 }, (_, i) => `wave2-${i}`);
                for (const [i, value] of secondWave.entries()) {
                    await adapterA.publish(topic, bytes(value), { key: `key-${i}` });
                }
                await waitFor(() => seenByA.filter((v) => v.startsWith("wave2-")).length >= secondWave.length, "survivor received the whole second wave");
                assert.deepEqual(
                    seenByA.filter((v) => v.startsWith("wave2-")).sort(),
                    [...secondWave].sort(),
                    "the survivor owns both partitions after the other member left",
                );
                assert.equal(seenByB.length, bAfterLeave, "the departed member receives nothing more");
            } finally {
                if (!bLeft) {
                    await subB.unsubscribe();
                }
                await subA.unsubscribe();
            }
        } finally {
            await adapterA.disconnect();
            await adapterB.disconnect();
        }
    });

    it("dead-letter path: an exhausted handler is published to the DLQ topic with error metadata and the original offset is committed", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.dlq-source"));
        const dlqTopic = await createTopic(uniqueName("it.dlq"));
        const group = uniqueName("group");
        const adapter = newAdapter();
        const dlqEvents: RawEvent[] = [];
        const sourceDeliveries: RawEvent[] = [];

        await adapter.connect();
        try {
            const middleware = dlqMiddleware({ topic: dlqTopic }, adapter);

            const dlqSubscription = await adapter.subscribe(
                [dlqTopic],
                async (event, ack) => {
                    dlqEvents.push(event);
                    await ack();
                },
                { group: uniqueName("group") },
            );
            const sourceSubscription = await adapter.subscribe(
                [topic],
                async (event, ack, nack) => {
                    sourceDeliveries.push(event);
                    const ctx = createEventContext({
                        raw: event,
                        signal: new AbortController().signal,
                        onAck: ack,
                        onNack: nack,
                    });
                    await middleware(event, ctx, async () => {
                        throw new TypeError("poison message");
                    });
                },
                { group },
            );
            try {
                const payload = bytes("poison");
                await adapter.publish(topic, payload, { metadata: { "trace-id": "t-1" } });

                await waitFor(() => dlqEvents.length >= 1, "message arrived on the DLQ topic");
                await waitFor(async () => (await committedOffset(group, topic)) === 1, "original offset committed", async () => ({ committed: await committedOffset(group, topic), source: sourceDeliveries.length, dlq: dlqEvents.length }));
                await sleep(1_000);

                assert.equal(sourceDeliveries.length, 1, "the original is delivered exactly once");
                assert.equal(dlqEvents.length, 1);
                const [dead] = dlqEvents;
                assert.ok(dead);
                assert.equal(dead.eventType, dlqTopic);
                assert.deepEqual(dead.payload, payload);
                assert.equal(dead.metadata.get("dlq.original-topic"), topic);
                assert.equal(dead.metadata.get("dlq.original-id"), sourceDeliveries[0]?.eventId);
                assert.equal(dead.metadata.get("dlq.error"), "TypeError");
                assert.equal(dead.metadata.get("dlq.attempt"), "1");
            } finally {
                await sourceSubscription.unsubscribe();
                await dlqSubscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });
});

describe("Kafka adapter commit strategy on a real broker", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const kafka = new Kafka({ clientId: "integration-control-commit", brokers, logLevel: logLevel.ERROR });
    const admin: Admin = kafka.admin();
    const createdTopics: string[] = [];
    let adminConnected = false;

    async function createTopic(name: string): Promise<string> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
        const created = await admin.createTopics({ waitForLeaders: true, topics: [{ topic: name, numPartitions: 1, replicationFactor: 1 }] });
        assert.equal(created, true, `topic ${name} was not created`);
        createdTopics.push(name);
        return name;
    }

    async function committedOffset(groupId: string, topic: string): Promise<number> {
        const [entry] = await admin.fetchOffsets({ groupId, topics: [topic] });
        return Number(entry?.partitions.find((p) => p.partition === 0)?.offset ?? -1);
    }

    /**
     * Adapter whose KafkaJS client logs at DEBUG level into a counter of the `OffsetCommit` requests it
     * sends. KafkaJS writes one "Request OffsetCommit(...)" line per request before it goes on the wire,
     * so the count is what the broker is asked to do, not what the adapter believes it did.
     */
    function newCountingAdapter(commitStrategy: "per-message" | "per-batch" | undefined): { adapter: EventAdapter; offsetCommitRequests: () => number } {
        let count = 0;
        const adapter = KafkaAdapter({
            brokers,
            clientId: uniqueName("integration"),
            kafkaConfig: {
                logLevel: logLevel.DEBUG,
                logCreator: () => (entry) => {
                    if (entry.log.message.startsWith("Request OffsetCommit(")) count++;
                },
            },
            consumerOptions: { fromBeginning: true, redeliveryDelay: 0, ...(commitStrategy !== undefined && { commitStrategy }) },
        });
        return { adapter, offsetCommitRequests: () => count };
    }

    /** Publish `count` messages `m0`..`m<count-1>` before any consumer exists, so one fetch returns them all. */
    async function publishAll(adapter: EventAdapter, topic: string, count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
            await adapter.publish(topic, bytes(`m${i}`));
        }
    }

    after(async () => {
        if (!adminConnected) return;
        try {
            await admin.deleteTopics({ topics: createdTopics });
        } finally {
            await admin.disconnect();
        }
    });

    it("by default 20 acknowledged messages cost 20 OffsetCommit requests", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.commit-default"));
        const group = uniqueName("group");
        const handled: string[] = [];
        const { adapter, offsetCommitRequests } = newCountingAdapter(undefined);
        await adapter.connect();
        try {
            await publishAll(adapter, topic, 20);
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    handled.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 20, "offset 20 committed", async () => ({ handled: handled.length, requests: offsetCommitRequests() }));
                assert.equal(handled.length, 20);
                assert.equal(offsetCommitRequests(), 20);
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("per-batch: 20 acknowledged messages of one batch cost a single OffsetCommit request, and none is delivered again", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.commit-batch"));
        const group = uniqueName("group");
        const handled: string[] = [];
        const { adapter, offsetCommitRequests } = newCountingAdapter("per-batch");
        await adapter.connect();
        try {
            await publishAll(adapter, topic, 20);
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    handled.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 20, "offset 20 committed", async () => ({ handled: handled.length, requests: offsetCommitRequests() }));
                await sleep(1_000);
                assert.deepEqual(handled, Array.from({ length: 20 }, (_, i) => `m${i}`), "every message exactly once, in order");
                assert.equal(offsetCommitRequests(), 1);
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("per-batch: a requeue in the middle of a batch commits the acknowledged prefix and redelivers from the requeued message", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.commit-batch-requeue"));
        const group = uniqueName("group");
        const handled: string[] = [];
        let requeued = false;
        const { adapter, offsetCommitRequests } = newCountingAdapter("per-batch");
        await adapter.connect();
        try {
            await publishAll(adapter, topic, 20);
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack, nack) => {
                    const value = text(event.payload);
                    handled.push(value);
                    if (value === "m7" && !requeued) {
                        requeued = true;
                        await nack(true);
                        return;
                    }
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 20, "offset 20 committed", async () => ({ handled, requests: offsetCommitRequests() }));
                await sleep(1_000);
                const expected = [...Array.from({ length: 8 }, (_, i) => `m${i}`), ...Array.from({ length: 13 }, (_, i) => `m${i + 7}`)];
                assert.deepEqual(handled, expected, "m0..m6 once, m7 twice, the rest once");
                assert.equal(offsetCommitRequests(), 2, "one commit for the prefix, one for the redelivered tail");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("per-batch: a handler that keeps throwing leaves exactly the acknowledged prefix committed", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.commit-batch-throw"));
        const group = uniqueName("group");
        const handled: string[] = [];
        const { adapter } = newCountingAdapter("per-batch");
        await adapter.connect();
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await publishAll(adapter, topic, 10);
            const subscription = await adapter.subscribe(
                [topic],
                async (event, ack) => {
                    const value = text(event.payload);
                    handled.push(value);
                    if (value === "m5") throw new Error("poison");
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 5, "offset 5 committed", async () => ({ handled }));
                await sleep(1_000);
                assert.equal(await committedOffset(group, topic), 5, "the failing message is never committed");
                assert.deepEqual(handled.slice(0, 6), ["m0", "m1", "m2", "m3", "m4", "m5"]);
                assert.equal(handled.filter((v) => v === "m0").length, 1, "the acknowledged prefix is not redelivered");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            console.error = originalError;
            await adapter.disconnect();
        }
    });

    it("per-batch: unsubscribe in the middle of a batch commits what was acknowledged and leaves the rest for the next consumer", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("it.commit-batch-stop"));
        const group = uniqueName("group");
        const firstRun: string[] = [];
        const { adapter: adapter1 } = newCountingAdapter("per-batch");
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let m2Started = false;

        await adapter1.connect();
        try {
            await publishAll(adapter1, topic, 5);
            const subscription = await adapter1.subscribe(
                [topic],
                async (event, ack) => {
                    const value = text(event.payload);
                    firstRun.push(value);
                    if (value === "m2") {
                        m2Started = true;
                        await gate;
                    }
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(() => m2Started, "m2 is being handled", () => ({ firstRun }));
                const stopping = subscription.unsubscribe();
                await sleep(300);
                release?.();
                await stopping;
            } finally {
                release?.();
            }
        } finally {
            await adapter1.disconnect();
        }
        assert.deepEqual(firstRun, ["m0", "m1", "m2"], "m3 must not start after the consumer was told to stop");
        assert.equal(await committedOffset(group, topic), 3, "m0, m1 and m2 were acknowledged and are committed");

        const secondRun: string[] = [];
        const { adapter: adapter2 } = newCountingAdapter("per-batch");
        await adapter2.connect();
        try {
            const subscription = await adapter2.subscribe(
                [topic],
                async (event, ack) => {
                    secondRun.push(text(event.payload));
                    await ack();
                },
                { group },
            );
            try {
                await waitFor(async () => (await committedOffset(group, topic)) === 5, "offset 5 committed", async () => ({ secondRun }));
                assert.deepEqual(secondRun, ["m3", "m4"], "only what was not acknowledged comes back");
            } finally {
                await subscription.unsubscribe();
            }
        } finally {
            await adapter2.disconnect();
        }
    });
});

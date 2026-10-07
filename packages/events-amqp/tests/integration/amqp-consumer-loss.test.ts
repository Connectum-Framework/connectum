/**
 * Consumer-loss integration tests using testcontainers.
 *
 * The broker ends a consumer while the connection stays up (its queue is
 * deleted, the consumer channel is closed by a channel exception). These
 * scenarios drive the broker with `rabbitmqctl` through `container.exec`, so
 * they run in the same gated job as the connection-recovery suite
 * (RUN_RECOVERY_TESTS=1): a plain `pnpm test` without Docker stays green.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(100);
    }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (payload: Uint8Array): string => new TextDecoder().decode(payload);

describe("AMQP consumer loss on a live connection (testcontainers)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;

    async function ctl(...args: string[]): Promise<string> {
        const res = await container.exec(["rabbitmqctl", "-q", ...args]);
        if (res.exitCode !== 0) {
            throw new Error(`rabbitmqctl ${args.join(" ")} failed (${res.exitCode}): ${res.output}`);
        }
        return res.output;
    }

    async function listQueues(): Promise<string[]> {
        const out = await ctl("list_queues", "name", "--no-table-headers");
        return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    }

    async function consumersOn(queue: string): Promise<string[]> {
        const out = await ctl("list_consumers", "--no-table-headers");
        return out.split("\n").filter((line) => line.startsWith(queue));
    }

    before(async () => {
        container = await new GenericContainer(RABBITMQ_IMAGE).withExposedPorts(5672).start();
        url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
    });

    after(async () => {
        await container?.stop();
    });

    it("a deleted group queue is reported, re-declared, and delivers again", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.group",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["loss.group.evt"],
                async (event, ack) => {
                    received.push(decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("loss.group.evt", encode("before"));
            await waitFor(() => received.length === 1);

            await ctl("delete_queue", "loss.group.g");

            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            const lost = events.find((e) => e.type === "consumer-lost");
            assert.ok(lost?.type === "consumer-lost");
            assert.equal(lost.queue, "loss.group.g");
            assert.equal(lost.cause, "cancelled");
            assert.equal(lost.willRestore, true);

            await waitFor(() => events.some((e) => e.type === "consumer-restored"));
            const restored = events.find((e) => e.type === "consumer-restored");
            assert.ok(restored?.type === "consumer-restored");
            assert.equal(restored.queue, "loss.group.g");
            assert.equal(restored.attempt, 1);

            await adapter.publish("loss.group.evt", encode("after"));
            await waitFor(() => received.length === 2);
            assert.deepEqual(received, ["before", "after"]);
            assert.equal(events.filter((e) => e.type === "consumer-lost").length, 1, "one loss produces one event");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a deleted auto-named queue is reported, replaced by a new one, and delivers again", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.auto",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(["loss.auto.evt"], async (event, ack) => {
                received.push(decode(event.payload));
                await ack();
            });
            const original = (await listQueues()).filter((name) => name.startsWith("loss.auto.sub-"));
            assert.equal(original.length, 1, "exactly one auto-named queue exists after subscribe");
            const [originalName] = original;
            assert.ok(originalName !== undefined);

            await ctl("delete_queue", originalName);

            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            const lost = events.find((e) => e.type === "consumer-lost");
            assert.ok(lost?.type === "consumer-lost");
            assert.equal(lost.queue, originalName);
            assert.equal(lost.cause, "cancelled");

            await waitFor(() => events.some((e) => e.type === "consumer-restored"));
            const restored = events.find((e) => e.type === "consumer-restored");
            assert.ok(restored?.type === "consumer-restored");
            assert.notEqual(restored.queue, originalName, "an auto-named subscription gets a new queue");

            const after = (await listQueues()).filter((name) => name.startsWith("loss.auto.sub-"));
            assert.deepEqual(after, [restored.queue], "only the restored queue exists, nothing leaked");

            await adapter.publish("loss.auto.evt", encode("after"));
            await waitFor(() => received.length === 1);
            assert.deepEqual(received, ["after"]);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a consumer channel the broker closes is reported as channel-closed and the subscription keeps delivering", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.chan",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["loss.chan.evt"],
                async (event, ack) => {
                    received.push(decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("loss.chan.evt", encode("before"));
            await waitFor(() => received.length === 1);

            // The broker sends `channel.close` 406 to the one channel that has a
            // consumer, the frame a channel exception produces. Observed: after
            // this injected close the broker also drops the connection, so what
            // the adapter does after the loss (restore on this connection, or
            // rebuild on the next) is not asserted here, only the loss itself and
            // the final state. The restoration path is exercised by the
            // deleted-queue scenarios.
            await ctl(
                "eval",
                "[rabbit_channel:send_command(proplists:get_value(pid, I), {'channel.close', 406, list_to_binary(\"PRECONDITION_FAILED - injected\"), 0, 0}) || I <- rabbit_channel:info_all([pid, consumer_count]), proplists:get_value(consumer_count, I) > 0].",
            );

            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            const lost = events.find((e) => e.type === "consumer-lost");
            assert.ok(lost?.type === "consumer-lost");
            assert.equal(lost.queue, "loss.chan.g");
            assert.equal(lost.cause, "channel-closed");
            assert.ok(lost.error instanceof Error, "the channel exception is carried as error");
            assert.equal(lost.willRestore, true);

            await waitFor(() => events.filter((e) => e.type === "connected").length >= 2 || events.some((e) => e.type === "consumer-restored"));
            await sleep(1_500);
            assert.equal((await consumersOn("loss.chan.g")).length, 1, "exactly one consumer afterwards");
            await adapter.publish("loss.chan.evt", encode("after"));
            await waitFor(() => received.length === 2);
            assert.deepEqual(received, ["before", "after"]);
            assert.equal(events.filter((e) => e.type === "consumer-lost").length, 1, "one loss produces one event");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a handler that throws synchronously is requeued and the subscription keeps consuming", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.sync",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const attempts: number[] = [];
            const received: string[] = [];
            await adapter.subscribe(
                ["loss.sync.evt"],
                (event, ack): Promise<void> => {
                    attempts.push(event.attempt);
                    if (attempts.length === 1) {
                        // A plain throw, not a rejected promise: it escapes the consume
                        // callback and amqplib answers by closing the channel with 541.
                        throw new Error("synchronous handler failure");
                    }
                    received.push(decode(event.payload));
                    return ack();
                },
                { group: "g" },
            );
            await adapter.publish("loss.sync.evt", encode("first"));
            await waitFor(() => received.length === 1);
            assert.deepEqual(attempts, [1, 2], "the failed delivery came back as a later attempt");

            await adapter.publish("loss.sync.evt", encode("second"));
            await waitFor(() => received.length === 2);
            assert.equal(events.some((e) => e.type === "consumer-lost"), false, "a handler failure is not a consumer loss");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("dropping every connection is not a consumer loss and leaves exactly one consumer", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.drop",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["loss.drop.evt"],
                async (event, ack) => {
                    received.push(decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );

            await ctl("close_all_connections", "test-drop");
            await waitFor(() => events.filter((e) => e.type === "connected").length >= 2);
            // Let any restoration the adapter might wrongly start land before counting.
            await sleep(1_500);

            const consumers = await consumersOn("loss.drop.g");
            assert.equal(consumers.length, 1, `exactly one consumer on the queue, got: ${JSON.stringify(consumers)}`);

            await adapter.publish("loss.drop.evt", encode("once"));
            await waitFor(() => received.length >= 1);
            await sleep(500);
            assert.deepEqual(received, ["once"], "one consumer, one delivery");
            assert.equal(
                events.some((e) => e.type === "consumer-lost" || e.type === "consumer-restored" || e.type === "consumer-restore-failed"),
                false,
                "connection recovery owns this case; no consumer-loss events",
            );
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("topology mode check: a deleted queue is not re-created, the restoration ends with willRetry false", { timeout: 60_000 }, async () => {
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("loss.check", "topic", { durable: true });
        await preCh.assertQueue("loss.check.g", { durable: true });
        await preCh.close();
        await pre.close();

        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.check",
            exchangeType: "topic",
            topologyMode: "check",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            await adapter.subscribe(["loss.check.evt"], async (_event, ack) => ack(), { group: "g" });

            await ctl("delete_queue", "loss.check.g");

            await waitFor(() => events.some((e) => e.type === "consumer-restore-failed"));
            const failed = events.find((e) => e.type === "consumer-restore-failed");
            assert.ok(failed?.type === "consumer-restore-failed");
            assert.equal(failed.queue, "loss.check.g");
            assert.equal(failed.willRetry, false, "a missing queue cannot heal by retrying in check mode");
            assert.ok(failed.error instanceof AmqpTopologyError);

            await sleep(1_000);
            assert.equal(events.filter((e) => e.type === "consumer-restore-failed").length, 1, "the restoration stopped after the deterministic failure");
            assert.equal(events.some((e) => e.type === "consumer-restored"), false);
            assert.equal((await listQueues()).includes("loss.check.g"), false, "check mode must not create the queue");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("recovery false: the loss is reported with willRestore false and nothing is restored", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.norec",
            exchangeType: "topic",
            recovery: false,
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            await adapter.subscribe(["loss.norec.evt"], async (_event, ack) => ack(), { group: "g" });

            await ctl("delete_queue", "loss.norec.g");

            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            const lost = events.find((e) => e.type === "consumer-lost");
            assert.ok(lost?.type === "consumer-lost");
            assert.equal(lost.willRestore, false);

            await sleep(1_500);
            assert.equal(events.some((e) => e.type === "consumer-restored" || e.type === "consumer-restore-failed"), false);
            assert.equal((await listQueues()).includes("loss.norec.g"), false, "nothing re-declared the queue");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a queue deleted again right after a restoration is restored on a longer delay", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.repeat",
            exchangeType: "topic",
            recovery: { initialDelay: 200, maxDelay: 2_000, jitter: 0 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["loss.repeat.evt"],
                async (event, ack) => {
                    received.push(decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );

            await ctl("delete_queue", "loss.repeat.g");
            await waitFor(() => events.filter((e) => e.type === "consumer-restored").length === 1);

            const secondLossAt = Date.now();
            await ctl("delete_queue", "loss.repeat.g");
            await waitFor(() => events.filter((e) => e.type === "consumer-restored").length === 2);
            const secondRestoreTook = Date.now() - secondLossAt;

            const attempts = events.flatMap((e) => (e.type === "consumer-restored" ? [e.attempt] : []));
            assert.deepEqual(attempts, [1, 2], "the attempt number keeps growing while restorations follow each other");
            assert.ok(secondRestoreTook >= 400, `the second restoration waited the grown delay (took ${secondRestoreTook} ms, expected at least 400)`);

            await adapter.publish("loss.repeat.evt", encode("after"));
            await waitFor(() => received.length === 1);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("the connection dropping during the restoration backoff leaves exactly one consumer and one delivery", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.dropmid",
            exchangeType: "topic",
            // The delay is far longer than one rabbitmqctl call (about half a
            // second through container.exec), so the connection is dropped while
            // the first restoration attempt is still waiting.
            recovery: { initialDelay: 4_000, maxDelay: 8_000, jitter: 0 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["loss.dropmid.evt"],
                async (event, ack) => {
                    received.push(decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );

            await ctl("delete_queue", "loss.dropmid.g");
            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            await ctl("close_all_connections", "test-drop-mid-restore");
            await waitFor(() => events.filter((e) => e.type === "connected").length >= 2);
            assert.equal(
                events.some((e) => e.type === "consumer-restored" || e.type === "consumer-restore-failed"),
                false,
                "the drop landed inside the first backoff, before any restoration attempt",
            );
            // Outlast the cancelled attempt's delay: a timer that survived the drop would fire now.
            await sleep(5_000);

            const consumers = await consumersOn("loss.dropmid.g");
            assert.equal(consumers.length, 1, `exactly one consumer on the queue, got: ${JSON.stringify(consumers)}`);
            assert.equal(
                events.some((e) => e.type === "consumer-restored" || e.type === "consumer-restore-failed"),
                false,
                "connection recovery rebuilt the consumer; the cancelled restoration reported nothing",
            );

            await adapter.publish("loss.dropmid.evt", encode("once"));
            await waitFor(() => received.length >= 1);
            await sleep(500);
            assert.deepEqual(received, ["once"], "one consumer, one delivery");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("unsubscribe during the restoration backoff cancels the restoration", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.unsub",
            exchangeType: "topic",
            recovery: { initialDelay: 1_000, maxDelay: 2_000, jitter: 0 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(["loss.unsub.evt"], async (_event, ack) => ack(), { group: "g" });

            await ctl("delete_queue", "loss.unsub.g");
            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            await subscription.unsubscribe();

            await sleep(2_000);
            assert.equal(events.some((e) => e.type === "consumer-restored" || e.type === "consumer-restore-failed"), false);
            assert.equal((await listQueues()).includes("loss.unsub.g"), false, "an unsubscribed subscription must not re-declare its queue");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("disconnect during the restoration backoff cancels the restoration", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "loss.disc",
            exchangeType: "topic",
            recovery: { initialDelay: 1_000, maxDelay: 2_000, jitter: 0 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        await adapter.subscribe(["loss.disc.evt"], async (_event, ack) => ack(), { group: "g" });

        await ctl("delete_queue", "loss.disc.g");
        await waitFor(() => events.some((e) => e.type === "consumer-lost"));
        await adapter.disconnect();

        await sleep(2_000);
        assert.equal(events.some((e) => e.type === "consumer-restored" || e.type === "consumer-restore-failed"), false);
        assert.equal((await listQueues()).includes("loss.disc.g"), false, "a disconnected adapter must not re-declare a queue");
    });

    it("the broker log has no unknown delivery tag from any scenario above", { timeout: 30_000 }, async () => {
        const stream = await container.logs();
        const chunks: string[] = [];
        stream.on("data", (chunk: Buffer | string) => chunks.push(chunk.toString()));
        await sleep(1_500);
        stream.destroy();

        const log = chunks.join("");
        assert.ok(log.length > 0, "the broker log was read");
        assert.equal(log.includes("unknown delivery tag"), false, "an ack/nack/requeue reached a channel that no longer owned the delivery");
    });
});

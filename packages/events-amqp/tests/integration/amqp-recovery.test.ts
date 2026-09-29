/**
 * Connection-recovery integration tests using testcontainers.
 *
 * Unlike amqp-broker.test.ts (which only needs a reachable broker), these
 * scenarios drop client connections at the broker mid-test, so they manage a
 * RabbitMQ container programmatically (`container.exec` → rabbitmqctl). Gated
 * behind RUN_RECOVERY_TESTS=1 (set in the dedicated CI job) so a plain
 * `pnpm test` without Docker stays green.
 *
 * Covers the recovery × ConfirmChannel gate from the
 * events-amqp-external-contract change:
 * 1. connection drop → reconnect restores publishing and consuming
 * 2. publish-while-disconnected fails fast (recovery disabled)
 * 3. reconnect-during-publish (mid-confirm) → the in-flight promise settles
 *    (never hangs), rejecting with a typed connection/timeout error
 * 4. topology mismatch on assert → AmqpTopologyError (PRECONDITION_FAILED 406)
 * 5. reconnect-during-subscribe → consumer is replayed and resumes delivery
 * 6. publishTimeoutMs → frozen broker (docker pause, no confirm) rejects with
 *    AmqpPublishTimeoutError (deterministic, unlike a fast live broker)
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { type CreatedProxy, type StartedToxiProxyContainer, ToxiProxyContainer } from "@testcontainers/toxiproxy";
import { connect } from "amqplib";
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter, isConnectionLostError } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpPublishNackError, AmqpPublishTimeoutError, AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";

const execFileAsync = promisify(execFile);

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

/**
 * Settle `promise` or fail after `ms`. node:test has no default per-test
 * timeout, so a promise that never settles (a subscribe() against a dead
 * recovery cycle, a recovery that falls back instead of giving up) would hang
 * the whole run — the bound turns that hang into a readable assertion failure.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** Nothing listens on port 1 of the loopback: every connection attempt is refused at once. */
const UNREACHABLE_URL = "amqp://guest:guest@127.0.0.1:1";

describe("AMQP connection recovery (testcontainers)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;

    /**
     * Force-drop all client connections at the broker without restarting it.
     * The broker stays up (port stable, no cold start), so recovery reconnects
     * immediately — this exercises the reconnect + ConfirmChannel/consumer
     * re-creation path deterministically. (A full broker restart would also
     * test topology re-declaration but is slow and flaky on a cold RabbitMQ.)
     */
    async function dropConnections(): Promise<void> {
        const res = await container.exec(["rabbitmqctl", "close_all_connections", "test-drop"]);
        if (res.exitCode !== 0) {
            throw new Error(`close_all_connections failed (${res.exitCode}): ${res.output}`);
        }
    }

    /**
     * Bring the broker app back and wait until it accepts AMQP connections.
     * The container is shared by every test in this file: leaving the app
     * stopped (or half-started) would fail all later tests in cascade.
     */
    async function restoreBrokerApp(): Promise<void> {
        await container.exec(["rabbitmqctl", "start_app"]);
        const deadline = Date.now() + 60_000;
        for (;;) {
            try {
                const probe = await connect(url);
                await probe.close();
                return;
            } catch (err) {
                if (Date.now() > deadline) {
                    throw err;
                }
                await sleep(200);
            }
        }
    }

    before(async () => {
        container = await new GenericContainer("rabbitmq:4-alpine").withExposedPorts(5672).start();
        url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
    });

    after(async () => {
        await container?.stop();
    });

    it("connection drop → reconnect restores publishing and consuming", async () => {
        const lifecycle: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.restart",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
                onDisconnected: () => lifecycle.push("disconnected"),
                onReconnecting: () => lifecycle.push("reconnecting"),
                onReconnectFailed: () => lifecycle.push("reconnect-failed"),
            },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["rec.restart.evt"],
                async (event, ack) => {
                    received.push(new TextDecoder().decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );

            await adapter.publish("rec.restart.evt", new TextEncoder().encode("before"));
            await waitFor(() => received.length === 1);

            await dropConnections();
            await waitFor(() => lifecycle.includes("disconnected"));
            await waitFor(() => lifecycle.filter((e) => e === "connected").length >= 2);

            // Confirm channel and consumer must have been re-created by setup
            await adapter.publish("rec.restart.evt", new TextEncoder().encode("after"));
            await waitFor(() => received.length === 2);

            assert.deepEqual(received, ["before", "after"]);
        } finally {
            await adapter.disconnect();
        }
    });

    it("lifecycle exactly-once: connected once per (re)connect, disconnected once per drop (#197)", { timeout: 60_000 }, async () => {
        const events: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.lifecycle197",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => events.push("connected"),
                onDisconnected: () => events.push("disconnected"),
            },
        });
        await adapter.connect();
        try {
            assert.equal(events.filter((e) => e === "connected").length, 1, "initial connect fires onConnected exactly once");
            assert.equal(events.filter((e) => e === "disconnected").length, 0, "no disconnected before any drop");

            await dropConnections();
            await waitFor(() => events.filter((e) => e === "connected").length >= 2);
            // Settle window: let any late duplicate disconnected land before counting.
            await sleep(500);

            assert.equal(events.filter((e) => e === "connected").length, 2, "reconnect fires onConnected exactly once");
            assert.equal(
                events.filter((e) => e === "disconnected").length,
                1,
                "a single drop fires onDisconnected exactly once (no error+disconnect double-fire)",
            );
        } finally {
            await adapter.disconnect();
        }
    });

    it("onLifecycle union: initial connected{reconnected:false}, then disconnected → reconnecting → connected{reconnected:true} (#197)", { timeout: 60_000 }, async () => {
        const events: Array<{ type: string; reconnected?: boolean }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.union197",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });
        await adapter.connect();
        try {
            assert.deepEqual(
                events.filter((e) => e.type === "connected"),
                [{ type: "connected", reconnected: false }],
                "initial connect delivers exactly one connected{reconnected:false}",
            );

            await dropConnections();
            await waitFor(() => events.some((e) => e.type === "connected" && e.reconnected === true));
            await sleep(500);

            const types = events.map((e) => e.type);
            assert.equal(types.filter((t) => t === "disconnected").length, 1, "one disconnected per drop");
            assert.ok(types.includes("reconnecting"), "a reconnecting event is delivered before the re-connect");
            assert.ok(
                types.indexOf("disconnected") < types.indexOf("reconnecting") && types.indexOf("reconnecting") < types.lastIndexOf("connected"),
                `order must be disconnected → reconnecting → connected, got: ${types.join(", ")}`,
            );
            assert.deepEqual(
                events.filter((e) => e.type === "connected"),
                [
                    { type: "connected", reconnected: false },
                    { type: "connected", reconnected: true },
                ],
                "the recovery re-connect is flagged reconnected:true",
            );
        } finally {
            await adapter.disconnect();
        }
    });

    it("non-recovery mode: a server-forced graceful close surfaces exactly one disconnected; own disconnect() surfaces none (#197)", { timeout: 60_000 }, async () => {
        const events: Array<{ type: string }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.norec197",
            recovery: false,
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });
        await adapter.connect();
        try {
            // A graceful server close (replyCode 320) emits only 'close' — it
            // must still surface as a single disconnected (1.3.0 contract fix).
            await dropConnections();
            await waitFor(() => events.some((e) => e.type === "disconnected"));
            await sleep(500);
            assert.equal(events.filter((e) => e.type === "disconnected").length, 1, "a graceful server close fires disconnected exactly once");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
        // The adapter's own disconnect() is not a "loss" — no extra event.
        await sleep(300);
        assert.equal(events.filter((e) => e.type === "disconnected").length, 1, "own disconnect() must not emit disconnected");
    });

    it("non-recovery mode: disconnected carries the broker's close error with its reply code", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.norec.code",
            recovery: false,
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            await dropConnections();
            await waitFor(() => events.some((e) => e.type === "disconnected"));

            const event = events.find((e) => e.type === "disconnected");
            assert.ok(event?.type === "disconnected");
            assert.equal((event.error as { code?: number }).code, 320, "the broker's forced-close reply code reaches the caller instead of a generic message");
            assert.match(event.error.message, /320/);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a handler that fails after the connection dropped neither raises unhandledRejection nor loses the message", { timeout: 60_000 }, async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.settle",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const attempts: number[] = [];
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let processed = false;
            await adapter.subscribe(
                ["rec.settle.evt"],
                async (event, ack) => {
                    attempts.push(event.attempt);
                    if (attempts.length === 1) {
                        await gate;
                        throw new Error("handler failed after the channel was already gone");
                    }
                    await ack();
                    processed = true;
                },
                { group: "g" },
            );

            await adapter.publish("rec.settle.evt", new TextEncoder().encode("held"));
            await waitFor(() => attempts.length === 1);

            await dropConnections();
            await waitFor(() => events.some((e) => e.type === "disconnected"));
            release();
            await waitFor(() => events.some((e) => e.type === "settlement-skipped"));
            await waitFor(() => processed);
            await sleep(300);

            const skipped = events.find((e) => e.type === "settlement-skipped");
            assert.ok(skipped?.type === "settlement-skipped");
            assert.equal(skipped.action, "requeue");
            assert.equal(skipped.queue.length > 0, true);
            assert.equal(skipped.routingKey, "rec.settle.evt");
            assert.equal(unhandled.length, 0, "settling on a closed channel must not escape as an unhandled rejection");
            assert.equal(attempts.length, 2, "the broker redelivered the held message after recovery");
            assert.equal(attempts[1], 2, "the redelivery is marked as a later attempt");
        } finally {
            process.off("unhandledRejection", onUnhandled);
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry: a channel closed by the broker with an access refusal (403) is not retried and keeps the reply as cause", { timeout: 30_000 }, async () => {
        const setup = await connect(url);
        try {
            const channel = await setup.createChannel();
            await channel.assertExchange("rec.internal.gate", "topic", { internal: true });
            await channel.close();
        } finally {
            await setup.close();
        }

        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.internal.gate",
            topologyMode: "skip",
            publishRetry: { initialDelay: 200, maxDelay: 400, jitter: 0, maxRetries: 10, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            const startedAt = Date.now();
            await assert.rejects(
                () => adapter.publish("rec.internal.gate.evt", new Uint8Array([1])),
                (err: unknown) => {
                    assert.ok(err instanceof AmqpConnectionError, "surfaces as a connection-class error");
                    assert.equal(((err as Error).cause as { code?: number } | undefined)?.code, 403, "the broker's access refusal is the root cause");
                    return true;
                },
            );
            assert.ok(Date.now() - startedAt < 2_000, "a refusal the broker will repeat must not burn the retry budget");

            await assert.rejects(() => adapter.publish("rec.internal.gate.evt", new Uint8Array([2])));
            assert.deepEqual(retries, [], "neither publish was retried");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publish while disconnected fails fast with AmqpConnectionError (recovery disabled)", async () => {
        const adapter = AmqpAdapter({ url, exchange: "rec.failfast", recovery: false });
        await adapter.connect();
        try {
            await dropConnections();
            await sleep(1000); // let the close event propagate

            await assert.rejects(
                () => adapter.publish("rec.failfast.evt", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpConnectionError,
            );
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("reconnect during publish (mid-confirm): in-flight promise settles, never hangs", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.midconfirm",
            recovery: { initialDelay: 100, maxDelay: 500 },
            // Finite timeout proves "settles, never hangs" even in the worst case
            publishTimeoutMs: 8000,
        });
        await adapter.connect();
        try {
            // Fire a batch of publishes, then drop connections underneath them.
            // The key invariant: every in-flight publish promise SETTLES
            // (resolve or typed reject) — none hangs forever.
            const inflight = Array.from({ length: 20 }, (_, i) => adapter.publish("rec.midconfirm.evt", new TextEncoder().encode(`m${i}`)).then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
            ));
            await sleep(50);
            await dropConnections();

            const settled = await Promise.race([
                Promise.all(inflight),
                sleep(15_000).then(() => "TIMED_OUT" as const),
            ]);

            assert.notEqual(settled, "TIMED_OUT", "in-flight publishes must settle, not hang");
            const results = settled as Array<{ ok: true } | { ok: false; err: unknown }>;
            // A fast localhost broker may confirm all publishes before the drop,
            // so this asserts the invariant that holds either way: nothing hangs,
            // and any publish caught mid-flight rejects with AmqpConnectionError
            // — never AmqpPublishNackError (a drop is not a broker nack). The
            // error CLASSIFICATION itself is covered deterministically by the
            // isConnectionLostError unit test.
            for (const r of results) {
                if (!r.ok) {
                    assert.ok(r.err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${r.err}`);
                }
            }

            // After recovery the adapter must publish again (retry until the
            // connection is back up)
            let publishedAfter = false;
            for (let attempt = 0; attempt < 100 && !publishedAfter; attempt++) {
                try {
                    await adapter.publish("rec.midconfirm.evt", new TextEncoder().encode("post"));
                    publishedAfter = true;
                } catch {
                    await sleep(200);
                }
            }
            assert.ok(publishedAfter, "adapter must publish again after recovery");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("topology mismatch on assert → AmqpTopologyError (PRECONDITION_FAILED 406)", async () => {
        // Pre-declare a durable queue with one argument set via a throwaway connection.
        const pre = await connect(url);
        const ch = await pre.createChannel();
        await ch.assertQueue("rec.contract.q", { durable: true, arguments: { "x-max-length": 100 } });
        await ch.close();
        await pre.close();

        // Adapter asserts the SAME queue with a conflicting argument → 406.
        // applyTopology is the same code path used by the recovery setup callback,
        // so this also covers "mismatch on re-assert".
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.contract",
            exchangeType: "direct",
            recovery: false,
            topology: {
                queues: [{ name: "rec.contract.q", durable: true, arguments: { "x-max-length": 999 } }],
            },
        });

        await assert.rejects(
            () => adapter.connect(),
            (err: unknown) => {
                assert.ok(err instanceof AmqpTopologyError);
                // #202: the failing object is identified structurally, not by
                // parsing the broker reply text.
                assert.deepEqual(err.object, { kind: "queue", name: "rec.contract.q" });
                return true;
            },
        );
        await adapter.disconnect().catch(() => undefined);
    });

    it("publishRetry: a publish during the recovery window retries and succeeds once recovery completes (#195)", { timeout: 60_000 }, async () => {
        const retries: Array<{ attempt: number; delay: number }> = [];
        const received: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.pubretry195",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            publishRetry: { initialDelay: 50, maxDelay: 200, maxRetries: 30, onRetry: (info) => retries.push({ attempt: info.attempt, delay: info.delay }) },
        });
        await adapter.connect();
        try {
            await adapter.subscribe(
                ["rec.pubretry195.evt"],
                async (event, ack) => {
                    received.push(event.eventId);
                    await ack();
                },
                { group: "g" },
            );

            await dropConnections();
            // Publish IMMEDIATELY into the recovery window: pre-#195 this threw
            // AmqpConnectionError instantly; now it retries until recovery
            // completes and the message lands.
            await adapter.publish("rec.pubretry195.evt", new TextEncoder().encode("through-the-blip"));

            assert.ok(retries.length >= 1, "at least one retry was scheduled during the recovery window");
            assert.equal(retries[0]?.attempt, 1, "onRetry attempts are 1-based");
            await waitFor(() => received.length === 1);
        } finally {
            await adapter.disconnect();
        }
    });

    it("publishRetry: budget exhaustion during a live recovery cycle rethrows the LAST typed connection error (#195)", { timeout: 60_000 }, async () => {
        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.pubretry195x",
            recovery: { initialDelay: 100, maxDelay: 500 },
            publishRetry: { initialDelay: 20, maxDelay: 40, jitter: 0, maxRetries: 2, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            // Broker app down: the recovery cycle stays ALIVE (wrapper keeps
            // retrying), but every publish attempt fails — the bounded budget
            // exhausts long before the broker returns.
            await container.exec(["rabbitmqctl", "stop_app"]);
            await sleep(1000); // let the drop propagate

            await assert.rejects(
                () => adapter.publish("rec.pubretry195x.evt", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpConnectionError,
                "after the budget the last typed error surfaces",
            );
            assert.deepEqual(retries, [1, 2], "exactly maxRetries retries were attempted");
        } finally {
            await container.exec(["rabbitmqctl", "start_app"]).catch(() => undefined);
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry: recovery:false fails fast — no cycle exists to heal, zero retries (#195)", { timeout: 30_000 }, async () => {
        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.pubretry195nf",
            recovery: false,
            publishRetry: { initialDelay: 20, maxRetries: 5, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            await dropConnections();
            await sleep(1000);

            const startedAt = Date.now();
            await assert.rejects(
                () => adapter.publish("rec.pubretry195nf.evt", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpConnectionError,
            );
            assert.ok(Date.now() - startedAt < 1_000, "fail-fast: nothing will heal a non-recovering adapter");
            assert.deepEqual(retries, [], "no budget burned when no recovery cycle exists");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry: a broker nack is NOT auto-retried (boundary pin) (#195)", { timeout: 30_000 }, async () => {
        // Over-capacity queue with reject-publish → deterministic nack.
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("rec.nack195", "direct", { durable: true });
        await preCh.assertQueue("rec.nack195.q", { durable: true, arguments: { "x-max-length": 1, "x-overflow": "reject-publish" } });
        await preCh.bindQueue("rec.nack195.q", "rec.nack195", "k");
        await preCh.close();
        await pre.close();

        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.nack195",
            exchangeType: "direct",
            topologyMode: "skip",
            publishRetry: { initialDelay: 20, maxRetries: 5, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            // Fill the queue to capacity, then overflow → nack.
            await adapter.publish("k", new Uint8Array([1]));
            await assert.rejects(
                () => adapter.publish("k", new Uint8Array([2])),
                (err: unknown) => err instanceof AmqpPublishNackError,
                "the nack surfaces immediately",
            );
            assert.deepEqual(retries, [], "a nack never enters the retry loop");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry + single-flight: retries hold the chain — ordering preserved (#195)", { timeout: 60_000 }, async () => {
        const received: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.chain195",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            publisherOptions: { mandatory: true, correlationHeader: false },
            publishRetry: { initialDelay: 50, maxDelay: 200, maxRetries: 30 },
        });
        await adapter.connect();
        try {
            await adapter.subscribe(
                ["rec.chain195.evt"],
                async (event, ack) => {
                    received.push(new TextDecoder().decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );

            await dropConnections();
            // A enters the retry loop inside its single-flight slot; B queues
            // behind it. Hold-the-chain: B must not start (or land) before A.
            const a = adapter.publish("rec.chain195.evt", new TextEncoder().encode("A"));
            const b = adapter.publish("rec.chain195.evt", new TextEncoder().encode("B"));
            await Promise.all([a, b]);

            await waitFor(() => received.length === 2);
            assert.deepEqual(received, ["A", "B"], "ordering across the retrying slot is preserved");
        } finally {
            await adapter.disconnect();
        }
    });

    it("publishRetry: a deterministic channel-close (404) is NOT retried and surfaces the broker reply as cause (#195)", { timeout: 30_000 }, async () => {
        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url,
            // Never declared anywhere; skip mode publishes into the void and
            // the broker kills the CHANNEL with reply 404.
            exchange: "rec.nochannel195",
            topologyMode: "skip",
            publishRetry: { initialDelay: 200, maxDelay: 400, jitter: 0, maxRetries: 10, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            const startedAt = Date.now();
            await assert.rejects(
                () => adapter.publish("rec.nochannel195.evt", new Uint8Array([1])),
                (err: unknown) => {
                    assert.ok(err instanceof AmqpConnectionError, "surfaces as a connection-class error");
                    const cause = (err as Error).cause as { code?: number } | undefined;
                    assert.equal(cause?.code, 404, "the broker reply (404) is preserved as the root cause, not amqplib's generic 'channel closed'");
                    return true;
                },
            );
            const took = Date.now() - startedAt;
            assert.ok(took < 2_000, `a deterministic channel-close must not burn the retry budget (took ${took}ms)`);
            assert.deepEqual(retries, [], "zero retries for a deterministic channel-close");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry does not burn budget against a fatal topology stop (#195 × #201)", { timeout: 60_000 }, async () => {
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("rec.fatalretry", "topic", { durable: true });
        await preCh.assertQueue("rec.fatalretry.q", { durable: true });
        await preCh.close();
        await pre.close();

        const events: Array<{ type: string }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.fatalretry",
            recovery: { initialDelay: 100, maxDelay: 500 },
            topology: { queues: [{ name: "rec.fatalretry.q", durable: true }] },
            topologyMode: "check",
            treatTopologyErrorAsFatal: true,
            publishRetry: { initialDelay: 200, maxDelay: 400, maxRetries: 30 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const admin = await connect(url);
            const adminCh = await admin.createChannel();
            await adminCh.deleteQueue("rec.fatalretry.q");
            await adminCh.close();
            await admin.close();

            await dropConnections();
            await waitFor(() => events.some((e) => e.type === "reconnect-failed"), 30_000);

            // The cycle is terminally dead — the retry loop must recognize it
            // (connection === null) instead of burning 30 retries of backoff.
            const startedAt = Date.now();
            await assert.rejects(
                () => adapter.publish("rec.fatalretry.evt", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpConnectionError,
            );
            assert.ok(Date.now() - startedAt < 2_000, "no budget burn against a dead recovery cycle");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry: disconnect() during the backoff aborts the loop promptly with the last typed error (#195)", { timeout: 60_000 }, async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.abortretry195",
            recovery: { initialDelay: 30_000, maxDelay: 60_000 }, // recovery parked far away — the wrapper stays alive
            publishRetry: { initialDelay: 4000, maxDelay: 8000, jitter: 0, maxRetries: 5 },
        });
        await adapter.connect();
        try {
            await container.exec(["rabbitmqctl", "stop_app"]);
            await sleep(1000);

            const publishing = adapter.publish("rec.abortretry195.evt", new Uint8Array([1]));
            publishing.catch(() => undefined); // observer: the rejection is asserted below
            await sleep(300); // let the first attempt fail and enter the 4s backoff

            const abortStartedAt = Date.now();
            await adapter.disconnect();
            await assert.rejects(
                () => publishing,
                (err: unknown) => err instanceof AmqpConnectionError,
            );
            const latency = Date.now() - abortStartedAt;
            assert.ok(latency < 2_000, `disconnect() must interrupt the retry backoff promptly (took ${latency}ms of a 4000ms delay)`);
        } finally {
            await container.exec(["rabbitmqctl", "start_app"]).catch(() => undefined);
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("initialConnectMaxRetries: unreachable broker → per-attempt reconnecting events, terminal reconnect-failed, typed rejection (#198)", { timeout: 30_000 }, async () => {
        const events: Array<{ type: string; attempt?: number; delay?: number; error?: Error }> = [];
        const adapter = AmqpAdapter({
            url: UNREACHABLE_URL,
            exchange: "rec.bounded198",
            recovery: { initialDelay: 50, maxDelay: 100, initialConnectMaxRetries: 2 },
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });

        let eventsWhenRejected = -1;
        await assert.rejects(
            () => adapter.connect(),
            (err: unknown) => {
                eventsWhenRejected = events.length;
                assert.ok(err instanceof AmqpConnectionError, "budget exhaustion rejects typed");
                assert.equal(err.message, "Initial connect failed after 3 attempt(s) (initialConnectMaxRetries: 2)");
                const terminal = events.find((e) => e.type === "reconnect-failed");
                assert.ok(err.cause instanceof Error, "the last attempt's failure is the cause");
                assert.equal(err.cause, terminal?.error, "the cause is the same last connection error the terminal event reports");
                return true;
            },
        );

        // 2 retries = 3 attempts → reconnecting fired for attempts 1 and 2.
        assert.deepEqual(
            events.filter((e) => e.type === "reconnecting").map((e) => e.attempt),
            [1, 2],
            "per-attempt reconnecting events surface from the bounded initial phase",
        );
        assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 1, "exactly one terminal event");
        assert.equal(events.at(-1)?.type, "reconnect-failed", "the terminal event is the last one");
        assert.equal(eventsWhenRejected, events.length, "the terminal event is delivered before connect() rejects");
        assert.equal(events.filter((e) => e.type === "connected").length, 0);
        await adapter.disconnect().catch(() => undefined);
    });

    describe("initial connect budget contract", () => {
        /**
         * Count the broker connections whose `connection_name` client property
         * is `name` (the adapter sets it from `AdapterContext.serviceName`).
         * rabbitmqctl has no dedicated column for it, so the raw client
         * properties are matched; RabbitMQ 4 prints the pair as
         * `{"connection_name","<name>"}`.
         */
        async function countNamedConnections(name: string): Promise<number> {
            const res = await container.exec(["rabbitmqctl", "-q", "list_connections", "--no-table-headers", "client_properties"]);
            assert.equal(res.exitCode, 0, `list_connections failed (${res.exitCode}): ${res.output}`);
            return res.output.split("\n").filter((line) => line.includes(`{"connection_name","${name}"}`)).length;
        }

        /**
         * The broker registers and deregisters connections asynchronously, so
         * the census polls until it reaches `expected`, then re-checks after a
         * settle window — a late extra connection would show up there.
         */
        async function assertConnectionCensus(name: string, expected: number): Promise<void> {
            let count = -1;
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                count = await countNamedConnections(name);
                if (count === expected) {
                    break;
                }
                await sleep(200);
            }
            assert.equal(count, expected, `broker connections named '${name}'`);
            await sleep(1_000);
            assert.equal(await countNamedConnections(name), expected, `broker connections named '${name}' after the settle window`);
        }

        /** Make `queue` absent while `exchange` exists, so a check-mode setup fails with a deterministic 404. */
        async function prepareMissingQueue(exchange: string, queue: string): Promise<void> {
            const pre = await connect(url);
            try {
                const ch = await pre.createChannel();
                await ch.assertExchange(exchange, "topic", { durable: true });
                await ch.deleteQueue(queue).catch(() => undefined);
                await ch.close();
            } finally {
                await pre.close();
            }
        }

        async function createQueue(queue: string): Promise<void> {
            const healer = await connect(url);
            try {
                const ch = await healer.createChannel();
                await ch.assertQueue(queue, { durable: true });
                await ch.close();
            } finally {
                await healer.close();
            }
        }

        it("a topology failure in the initial window reports setup-failed{initial:true} with its attempt index, then the scheduled retry", { timeout: 30_000 }, async () => {
            await prepareMissingQueue("rec.initwin.topo", "rec.initwin.topo.q");
            const events: Array<{ type: string; initial?: boolean; attempt?: number }> = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.initwin.topo",
                recovery: { initialDelay: 50, maxDelay: 100, initialConnectMaxRetries: 1 },
                topology: { queues: [{ name: "rec.initwin.topo.q", durable: true }] },
                topologyMode: "check",
                lifecycle: {
                    onLifecycle: (event) =>
                        events.push({ type: event.type, ...("initial" in event ? { initial: event.initial } : {}), ...("attempt" in event ? { attempt: event.attempt } : {}) }),
                },
            });
            try {
                await assert.rejects(() => adapter.connect(), AmqpConnectionError);
                assert.deepEqual(events, [
                    { type: "setup-failed", initial: true, attempt: 0 },
                    { type: "reconnecting", attempt: 1 },
                    { type: "setup-failed", initial: true, attempt: 1 },
                    { type: "reconnect-failed" },
                ]);
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("publish() and subscribe() during the initial window reject with the typed 'not connected' error instead of waiting", { timeout: 30_000 }, async () => {
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url: UNREACHABLE_URL,
                exchange: "rec.initwin.pub",
                recovery: { initialDelay: 2_000, maxDelay: 2_000, jitter: 0, initialConnectMaxRetries: 5 },
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            const connecting = adapter.connect();
            connecting.catch(() => undefined);
            try {
                await waitFor(() => events.some((e) => e.type === "reconnecting"), 10_000);
                const notConnected = (err: unknown): boolean => err instanceof AmqpConnectionError && /not connected/.test(err.message);
                await assert.rejects(() => settleWithin(adapter.publish("rec.initwin.pub.evt", new Uint8Array([1])), 1_000), notConnected);
                await assert.rejects(() => settleWithin(adapter.subscribe(["rec.initwin.pub.evt"], async () => undefined), 1_000), notConnected);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await connecting.catch(() => undefined);
            }
        });

        it("fail-fast on topology drift: the first deterministic setup error rejects connect() after a single attempt", { timeout: 30_000 }, async () => {
            await prepareMissingQueue("rec.initwin.ff", "rec.initwin.ff.q");
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.initwin.ff",
                recovery: { initialDelay: 100, maxDelay: 200, initialConnectMaxRetries: 5 },
                topology: { queues: [{ name: "rec.initwin.ff.q", durable: true }] },
                topologyMode: "check",
                failFastOnInitialSetupError: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                await assert.rejects(() => adapter.connect(), AmqpTopologyError);
                // Settle window: a second attempt would report another setup-failed.
                await sleep(500);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["setup-failed"],
                    "one attempt, no scheduled retry, no terminal event",
                );
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("disconnect() during a 30 s initial backoff rejects connect() promptly, and nothing follows", { timeout: 30_000 }, async () => {
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url: UNREACHABLE_URL,
                exchange: "rec.initwin.abort",
                recovery: { initialDelay: 30_000, maxDelay: 30_000, jitter: 0, initialConnectMaxRetries: 5 },
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            const connecting = adapter.connect();
            connecting.catch(() => undefined);
            await waitFor(() => events.some((e) => e.type === "reconnecting"), 10_000);

            const abortStarted = Date.now();
            await adapter.disconnect();
            const eventsAtDisconnect = events.length;
            await assert.rejects(
                () => settleWithin(connecting, 2_000),
                (err: unknown) => {
                    assert.ok(err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(err)}`);
                    assert.equal(err.message, "Adapter closed during the initial connect phase");
                    return true;
                },
            );
            const abortLatency = Date.now() - abortStarted;
            assert.ok(abortLatency < 2_000, `disconnect() must cut the 30 s backoff short (took ${abortLatency}ms)`);
            await sleep(1_000);
            assert.equal(events.length, eventsAtDisconnect, "no attempt or lifecycle event after disconnect() resolved");
        });

        it("a subscribe() from the initial connected callback succeeds — connected is delivered once the adapter is usable", { timeout: 30_000 }, async () => {
            let subscribed: Promise<unknown> | null = null;
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.initwin.connected",
                recovery: { initialDelay: 50, maxDelay: 100, initialConnectMaxRetries: 2 },
                lifecycle: {
                    onLifecycle: (event) => {
                        if (event.type === "connected" && subscribed === null) {
                            // A named group: RabbitMQ 4 refuses the transient
                            // non-exclusive queue an ungrouped subscription declares.
                            subscribed = adapter.subscribe(["rec.initwin.connected.evt"], async () => undefined, { group: "g" });
                            subscribed.catch(() => undefined);
                        }
                    },
                },
            });
            try {
                await adapter.connect();
                assert.ok(subscribed !== null, "the initial connected event was delivered by the time connect() resolved");
                await settleWithin(subscribed as Promise<unknown>, 10_000);
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("broker connection census: exactly one adapter connection after a success on the third attempt", { timeout: 60_000 }, async () => {
            await prepareMissingQueue("rec.census.ok", "rec.census.ok.q");
            const name = `census-ok-${Date.now()}`;
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.census.ok",
                recovery: { initialDelay: 500, maxDelay: 500, jitter: 0, initialConnectMaxRetries: 5 },
                topology: { queues: [{ name: "rec.census.ok.q", durable: true }] },
                topologyMode: "check",
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                const connecting = adapter.connect({ serviceName: name });
                connecting.catch(() => undefined);
                // Two failed attempts, then heal inside the 500 ms wait before the third.
                await waitFor(() => events.filter((e) => e.type === "setup-failed").length >= 2, 20_000);
                await createQueue("rec.census.ok.q");
                await connecting;
                assert.equal(events.filter((e) => e.type === "setup-failed").length, 2, "the success came on the third attempt");
                await assertConnectionCensus(name, 1);
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("broker connection census: no adapter connection left after the budget is exhausted on topology failures", { timeout: 60_000 }, async () => {
            await prepareMissingQueue("rec.census.fail", "rec.census.fail.q");
            const name = `census-fail-${Date.now()}`;
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.census.fail",
                recovery: { initialDelay: 100, maxDelay: 200, initialConnectMaxRetries: 2 },
                topology: { queues: [{ name: "rec.census.fail.q", durable: true }] },
                topologyMode: "check",
            });
            try {
                await assert.rejects(() => adapter.connect({ serviceName: name }), AmqpConnectionError);
                await assertConnectionCensus(name, 0);
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("unset budget with a finite maxRetries: connect() rejects typed with the last connection error as cause, no per-retry events", { timeout: 30_000 }, async () => {
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url: UNREACHABLE_URL,
                exchange: "rec.initwin.unset",
                recovery: { initialDelay: 50, maxDelay: 100, maxRetries: 1 },
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                await assert.rejects(
                    () => settleWithin(adapter.connect(), 10_000),
                    (err: unknown) => {
                        assert.ok(err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(err)}`);
                        assert.ok(err.cause instanceof Error && /ECONNREFUSED/.test(`${(err.cause as { code?: string }).code} ${err.cause.message}`), "cause is the refused connection");
                        return true;
                    },
                );
                assert.equal(events.filter((e) => e.type === "reconnecting").length, 0, "the unset option keeps the initial window unreported");
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });

    it("initialConnectMaxRetries: boot-time drift surfaces setup-failed{initial:true} and heals within the budget (#198, 5.2a)", { timeout: 60_000 }, async () => {
        // Exchange exists, the check-mode queue does NOT — first attempt(s)
        // fail with a deterministic 404 until the queue appears.
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("rec.bootdrift198", "topic", { durable: true });
        await preCh.deleteQueue("rec.bootdrift198.q").catch(() => undefined);
        await preCh.close();
        await pre.close();

        const events: Array<{ type: string; initial?: boolean; attempt?: number; reconnected?: boolean }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.bootdrift198",
            recovery: { initialDelay: 400, maxDelay: 800, initialConnectMaxRetries: 8 },
            topology: { queues: [{ name: "rec.bootdrift198.q", durable: true }] },
            topologyMode: "check",
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });

        const connecting = adapter.connect();
        // A pre-wiring window that used to be silent: the bounded phase now
        // reports the boot-time drift per attempt.
        await waitFor(() => events.some((e) => e.type === "setup-failed" && e.initial === true), 20_000);

        // Heal the drift mid-phase — a later attempt must succeed.
        const healer = await connect(url);
        const healCh = await healer.createChannel();
        await healCh.assertQueue("rec.bootdrift198.q", { durable: true });
        await healCh.close();
        await healer.close();

        await connecting;
        try {
            assert.ok(
                events.filter((e) => e.type === "setup-failed" && e.initial === true).length >= 1,
                "boot-time drift was observable during the bounded phase",
            );
            assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0, "healed within the budget — no terminal event");
            assert.deepEqual(
                events.filter((e) => e.type === "connected"),
                [{ type: "connected", reconnected: false }],
                "the handoff connect delivers exactly one initial connected",
            );
            await adapter.publish("rec.bootdrift198.evt", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("initialConnectMaxRetries + failFastOnInitialSetupError: deterministic drift short-circuits the phase immediately (#198)", { timeout: 30_000 }, async () => {
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("rec.ffphase198", "topic", { durable: true });
        await preCh.deleteQueue("rec.ffphase198.q").catch(() => undefined);
        await preCh.close();
        await pre.close();

        const events: Array<{ type: string }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.ffphase198",
            recovery: { initialDelay: 100, maxDelay: 200, initialConnectMaxRetries: 5 },
            topology: { queues: [{ name: "rec.ffphase198.q", durable: true }] },
            topologyMode: "check",
            failFastOnInitialSetupError: true,
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });

        await assert.rejects(
            () => adapter.connect(),
            (err: unknown) => err instanceof AmqpTopologyError,
            "fail-fast wins over the budget: deterministic drift rejects on first sight",
        );
        assert.equal(events.filter((e) => e.type === "setup-failed").length, 1, "one setup-failed for the single attempt");
        assert.equal(events.filter((e) => e.type === "reconnecting").length, 0, "no retries were scheduled");
        await adapter.disconnect().catch(() => undefined);
    });

    it("initialConnectMaxRetries: disconnect() during the backoff aborts the phase promptly with a typed error (#198)", { timeout: 30_000 }, async () => {
        const events: Array<{ type: string }> = [];
        const adapter = AmqpAdapter({
            url: "amqp://guest:guest@127.0.0.1:1",
            exchange: "rec.abort198",
            // Long delays: without interruption the phase would park ~4s+.
            recovery: { initialDelay: 4000, maxDelay: 8000, jitter: 0, initialConnectMaxRetries: 5 },
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });

        const connecting = adapter.connect();
        await waitFor(() => events.some((e) => e.type === "reconnecting"), 10_000);

        const abortStarted = Date.now();
        await adapter.disconnect();
        await assert.rejects(
            () => connecting,
            (err: unknown) => {
                assert.ok(err instanceof AmqpConnectionError);
                assert.match((err as Error).message, /closed (during the initial connect phase|while connect\(\) was in progress)/);
                return true;
            },
        );
        const abortLatency = Date.now() - abortStarted;
        assert.ok(abortLatency < 2000, `disconnect() must interrupt the backoff promptly (took ${abortLatency}ms of a 4000ms delay)`);
        assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0, "an aborted phase is not a budget exhaustion");
    });

    it("treatTopologyErrorAsFatal: topology drift during recovery stops the cycle (setup-failed → reconnect-failed, no further retries) (#201)", { timeout: 60_000 }, async () => {
        // Pre-declare ALL check-mode objects (check mode verifies existence
        // and never asserts): the adapter's default exchange, the checked
        // queue, and the consumer-group queue used below.
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("rec.fatal201", "topic", { durable: true });
        await preCh.assertQueue("rec.fatal201.q", { durable: true });
        await preCh.assertQueue("rec.fatal201.grp", { durable: true });
        await preCh.close();
        await pre.close();

        const events: Array<{ type: string }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.fatal201",
            recovery: { initialDelay: 100, maxDelay: 500 },
            topology: { queues: [{ name: "rec.fatal201.q", durable: true }] },
            topologyMode: "check",
            treatTopologyErrorAsFatal: true,
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });
        await adapter.connect();
        try {
            // A live consumer before the drift — the fatal stop must tear it
            // down for good (no resurrection on a later connect()).
            await adapter.subscribe(["rec.fatal201.evt"], async (_event, ack) => {
                await ack();
            }, { group: "grp" });

            // Create the drift: the checked queue disappears while connected.
            const admin = await connect(url);
            const adminCh = await admin.createChannel();
            await adminCh.deleteQueue("rec.fatal201.q");
            await adminCh.close();
            await admin.close();

            // Drop connections → recovery re-runs setup → checkQueue fails 404
            // deterministically → fatal stop.
            await dropConnections();
            await waitFor(() => events.some((e) => e.type === "reconnect-failed"), 30_000);
            const countsAtStop = {
                setupFailed: events.filter((e) => e.type === "setup-failed").length,
                reconnecting: events.filter((e) => e.type === "reconnecting").length,
            };
            // Settle window: any further retry would emit reconnecting/setup-failed.
            await sleep(1500);

            assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 1, "terminal reconnect-failed fires exactly once");
            assert.equal(
                events.filter((e) => e.type === "setup-failed").length,
                countsAtStop.setupFailed,
                "no further setup-failed after the fatal stop — the cycle is dead",
            );
            assert.equal(
                events.filter((e) => e.type === "reconnecting").length,
                countsAtStop.reconnecting,
                "no reconnect is scheduled after the fatal stop (close() beats _scheduleReconnect)",
            );
            await assert.rejects(
                () => adapter.publish("rec.fatal201.evt", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpConnectionError,
                "publishes fail fast after the fatal stop",
            );

            // disconnect() after a fatal stop must resolve cleanly — no catch.
            await adapter.disconnect();

            // Reconnect-after-fatal: heal the drift, connect again — clean
            // slate, the old consumer must NOT be resurrected.
            const healer = await connect(url);
            const healCh = await healer.createChannel();
            await healCh.assertQueue("rec.fatal201.q", { durable: true });
            const before = await healCh.checkQueue("rec.fatal201.grp");
            assert.equal(before.consumerCount, 0, "the fatal stop killed the consumer");
            await healCh.close();
            await healer.close();

            await adapter.connect();
            await sleep(500); // any resurrection would re-attach the consumer here
            const admin2 = await connect(url);
            const adminCh2 = await admin2.createChannel();
            const after = await adminCh2.checkQueue("rec.fatal201.grp");
            assert.equal(after.consumerCount, 0, "connect() after fatal starts from a clean slate — no subscription resurrection");
            await adminCh2.close();
            await admin2.close();
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("default (no treatTopologyErrorAsFatal): topology drift during recovery keeps retrying and heals (#201 control)", { timeout: 60_000 }, async () => {
        const pre = await connect(url);
        const preCh = await pre.createChannel();
        await preCh.assertExchange("rec.heal201", "topic", { durable: true });
        await preCh.assertQueue("rec.heal201.q", { durable: true });
        await preCh.close();
        await pre.close();

        const events: Array<{ type: string }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.heal201",
            recovery: { initialDelay: 100, maxDelay: 500 },
            topology: { queues: [{ name: "rec.heal201.q", durable: true }] },
            topologyMode: "check",
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });
        await adapter.connect();
        try {
            const admin = await connect(url);
            const adminCh = await admin.createChannel();
            await adminCh.deleteQueue("rec.heal201.q");
            await adminCh.close();
            await admin.close();

            await dropConnections();
            // Default behavior: the cycle keeps retrying (setup-failed per attempt).
            await waitFor(() => events.filter((e) => e.type === "setup-failed").length >= 2, 30_000);
            assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0, "no terminal event under default policy");

            // Heal the drift → the next retry succeeds and the adapter reconnects.
            const healer = await connect(url);
            const healCh = await healer.createChannel();
            await healCh.assertQueue("rec.heal201.q", { durable: true });
            await healCh.close();
            await healer.close();

            await waitFor(() => events.some((e) => e.type === "connected" && (e as { reconnected?: boolean }).reconnected === true), 30_000);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    /**
     * Raw amqplib, no adapter: the recovery behaviors of amqplib 2.2.0 that the
     * adapter's backoff hook and bounded initial connect are built on. If a
     * later amqplib changes any of them, these fail first and point at the
     * library, not at the adapter.
     */
    describe("amqplib recovery contract the adapter relies on", () => {
        type RawEvent = { type: "connect-failed" | "reconnect-scheduled" | "reconnect-failed" | "connect"; attempt?: number; error?: Error };

        function recordRawEvents(model: EventEmitter): RawEvent[] {
            const events: RawEvent[] = [];
            model.on("connect-failed", (error: Error) => events.push({ type: "connect-failed", error }));
            model.on("reconnect-scheduled", (info: { attempt: number; error: Error }) => events.push({ type: "reconnect-scheduled", attempt: info.attempt, error: info.error }));
            model.on("reconnect-failed", (error: Error) => events.push({ type: "reconnect-failed", error }));
            model.on("connect", () => events.push({ type: "connect" }));
            // A recovering wrapper re-emits connection errors; without a listener they would crash the run.
            model.on("error", () => undefined);
            return events;
        }

        it("a throwing calculateDelay gives up recovery: connect() rejects with the thrown error itself", { timeout: 20_000 }, async () => {
            const boom = new Error("boom");
            let calls = 0;
            const connecting = connect(UNREACHABLE_URL, {
                recovery: {
                    calculateDelay: () => {
                        calls += 1;
                        throw boom;
                    },
                },
            });
            connecting.catch(() => undefined);
            // A fallback to the built-in delay would keep retrying forever under
            // the default maxRetries, so connect() would never settle.
            await assert.rejects(
                () => settleWithin(connecting, 5_000),
                (err: unknown) => err === boom,
            );
            await sleep(300);
            assert.equal(calls, 1, "the hook is consulted once and not again after the give-up");
        });

        it("a throwing calculateDelay: exactly one failed attempt, no retry scheduled, one reconnect-failed carrying the thrown error", { timeout: 20_000 }, async () => {
            const boom = new Error("boom");
            let calls = 0;
            const model = await connect(UNREACHABLE_URL, {
                recovery: {
                    waitForConnect: false,
                    calculateDelay: () => {
                        calls += 1;
                        throw boom;
                    },
                },
            });
            const events = recordRawEvents(model);
            try {
                await assert.rejects(
                    () => settleWithin(model.waitForConnect(), 5_000),
                    (err: unknown) => err === boom,
                );
                // Settle window: a second attempt would need a scheduled retry first.
                await sleep(500);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["connect-failed", "reconnect-failed"],
                    "one failed attempt, no reconnect-scheduled, then the give-up",
                );
                assert.equal(events[1]?.error, boom, "reconnect-failed carries the hook's error, not the connection error");
                assert.equal(calls, 1);
            } finally {
                await model.close();
            }
        });

        it("a calculateDelay returning a Promise gives up with the 'finite, non-negative number' error — the Promise is not awaited", { timeout: 20_000 }, async () => {
            let calls = 0;
            const model = await connect(UNREACHABLE_URL, {
                recovery: {
                    waitForConnect: false,
                    // A resolved Promise: had amqplib awaited it, the retry would be scheduled after 100 ms.
                    calculateDelay: () => {
                        calls += 1;
                        return Promise.resolve(100) as unknown as number;
                    },
                },
            });
            const events = recordRawEvents(model);
            try {
                await assert.rejects(
                    () => settleWithin(model.waitForConnect(), 5_000),
                    (err: unknown) => err instanceof Error && /finite, non-negative number/.test(err.message),
                );
                await sleep(500);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["connect-failed", "reconnect-failed"],
                );
                assert.equal(calls, 1, "no second attempt after the give-up");
            } finally {
                await model.close();
            }
        });

        it("initialMaxRetries bounds only the first connect: 1 retry = 2 attempts, then give-up, although maxRetries is Infinity", { timeout: 20_000 }, async () => {
            const model = await connect(UNREACHABLE_URL, {
                recovery: { waitForConnect: false, initialMaxRetries: 1, maxRetries: Number.POSITIVE_INFINITY, initialDelay: 50, maxDelay: 100 },
            });
            const events = recordRawEvents(model);
            try {
                await assert.rejects(() => settleWithin(model.waitForConnect(), 5_000));
                await sleep(500);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["connect-failed", "reconnect-scheduled", "connect-failed", "reconnect-failed"],
                );
                assert.equal(events[3]?.error, events[2]?.error, "the give-up reports the last attempt's error unchanged");
            } finally {
                await model.close();
            }
        });

        it("initialMaxRetries stops applying after the first success: a later outage retries beyond it under maxRetries", { timeout: 90_000 }, async () => {
            const model = await connect(url, {
                recovery: { waitForConnect: false, initialMaxRetries: 1, maxRetries: Number.POSITIVE_INFINITY, initialDelay: 100, maxDelay: 200 },
            });
            const events = recordRawEvents(model);
            try {
                await settleWithin(model.waitForConnect(), 20_000);
                const stop = await container.exec(["rabbitmqctl", "stop_app"]);
                assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
                // The initial budget of 1 would give up after the second attempt; the
                // steady-state budget (Infinity) keeps going.
                await waitFor(() => events.some((e) => e.type === "reconnect-scheduled" && (e.attempt ?? 0) >= 3), 30_000);
                assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0, "no give-up under the steady-state budget");
                await restoreBrokerApp();
                await waitFor(() => events.filter((e) => e.type === "connect").length >= 2, 30_000);
            } finally {
                await restoreBrokerApp();
                await model.close();
            }
        });

        it("waitForConnect: false resolves before the first attempt: listeners attached afterwards see the first connect-failed and reconnect-scheduled", { timeout: 20_000 }, async () => {
            const model = await connect(UNREACHABLE_URL, {
                recovery: { waitForConnect: false, initialMaxRetries: 1, initialDelay: 50, maxDelay: 100 },
            });
            // Attached synchronously after connect() resolved — the adapter's
            // lifecycle wiring does exactly this.
            const events = recordRawEvents(model);
            try {
                await assert.rejects(() => settleWithin(model.waitForConnect(), 5_000));
                assert.equal(events[0]?.type, "connect-failed", "the first attempt's failure is observed");
                assert.deepEqual(events[1], { type: "reconnect-scheduled", attempt: 1, error: events[0]?.error }, "the first scheduled retry is observed");
            } finally {
                await model.close();
            }
        });
    });

    describe("recovery.backoff hook", () => {
        type Recorded = { type: string; attempt?: number; delay?: number; error?: Error; at: number };

        function recorder(): { events: Recorded[]; onLifecycle: (event: AmqpLifecycleEvent) => void } {
            const events: Recorded[] = [];
            return {
                events,
                onLifecycle: (event) => {
                    events.push({
                        type: event.type,
                        ...("attempt" in event ? { attempt: event.attempt } : {}),
                        ...("delay" in event ? { delay: event.delay } : {}),
                        ...("error" in event ? { error: event.error } : {}),
                        at: Date.now(),
                    });
                },
            };
        }

        for (const initialConnectMaxRetries of [undefined, 3]) {
            const label = initialConnectMaxRetries === undefined ? "without initialConnectMaxRetries" : "with initialConnectMaxRetries";
            it(`a hook that throws during the initial connect rejects connect() with AmqpConnectionError caused by the thrown error, ${label}`, { timeout: 20_000 }, async () => {
                const boom = new Error("boom");
                let calls = 0;
                const { events, onLifecycle } = recorder();
                const adapter = AmqpAdapter({
                    url: UNREACHABLE_URL,
                    exchange: "rec.hook.throw",
                    recovery: {
                        ...(initialConnectMaxRetries === undefined ? {} : { initialConnectMaxRetries }),
                        backoff: () => {
                            calls += 1;
                            throw boom;
                        },
                    },
                    lifecycle: { onLifecycle },
                });
                try {
                    let rejection: unknown;
                    await assert.rejects(
                        () => settleWithin(adapter.connect(), 5_000),
                        (err: unknown) => {
                            rejection = err;
                            assert.ok(err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(err)}`);
                            assert.equal(err.cause, boom);
                            assert.match(err.message, /recovery\.backoff failed at attempt 1 \(boom\)/);
                            return true;
                        },
                    );
                    await sleep(500);
                    assert.equal(calls, 1, "no further attempt after the hook failed: no fallback to the built-in delay");
                    if (initialConnectMaxRetries === undefined) {
                        assert.match((rejection as Error).message, /last connection error: none observed/, "the initial window is not observable without a budget");
                        assert.deepEqual(events, [], "the unset option keeps the initial window unreported");
                    } else {
                        assert.match((rejection as Error).message, /last connection error: .*ECONNREFUSED/);
                        assert.deepEqual(
                            events.map((e) => e.type),
                            ["reconnect-failed"],
                        );
                        assert.equal(events[0]?.error, rejection, "the terminal event carries the same typed error connect() rejects with");
                    }
                } finally {
                    await adapter.disconnect().catch(() => undefined);
                }
            });
        }

        it("a hook returning an invalid value in steady state ends recovery with one reconnect-failed carrying a typed error", { timeout: 30_000 }, async () => {
            let calls = 0;
            const { events, onLifecycle } = recorder();
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.hook.invalid",
                recovery: {
                    backoff: () => {
                        calls += 1;
                        return -1;
                    },
                },
                lifecycle: { onLifecycle },
            });
            await adapter.connect();
            try {
                await dropConnections();
                await waitFor(() => events.some((e) => e.type === "reconnect-failed"), 10_000);
                await sleep(500);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["connected", "disconnected", "reconnect-failed"],
                    "no retry was scheduled and the give-up is reported once",
                );
                const terminal = events[2]?.error;
                assert.ok(terminal instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(terminal)}`);
                assert.ok(terminal.cause instanceof Error);
                assert.match(terminal.cause.message, /finite, non-negative number of milliseconds: attempt 1 returned -1/);
                assert.match(terminal.message, /last connection error: .*test-drop/, "the message names the connection error that started the recovery");
                assert.equal(calls, 1);
                await assert.rejects(
                    () => settleWithin(adapter.subscribe(["rec.hook.invalid.evt"], async () => undefined, { group: "g" }), 5_000),
                    (err: unknown) => err instanceof AmqpConnectionError && /not connected/.test(err.message),
                );
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("an async hook gives up on the first retry with 'must be synchronous', and its later rejection is not unhandled", { timeout: 20_000 }, async () => {
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown): void => {
                unhandled.push(reason);
            };
            process.on("unhandledRejection", onUnhandled);
            const adapter = AmqpAdapter({
                url: UNREACHABLE_URL,
                exchange: "rec.hook.async",
                recovery: {
                    initialConnectMaxRetries: 3,
                    backoff: (async () => {
                        await sleep(50);
                        throw new Error("late rejection of the hook's Promise");
                    }) as unknown as (attempt: number) => number,
                },
            });
            try {
                await assert.rejects(
                    () => settleWithin(adapter.connect(), 5_000),
                    (err: unknown) => {
                        assert.ok(err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(err)}`);
                        assert.ok(err.cause instanceof Error);
                        assert.match(err.cause.message, /must be synchronous/);
                        return true;
                    },
                );
                // Well past the Promise's own rejection.
                await sleep(300);
                assert.deepEqual(unhandled, []);
            } finally {
                process.off("unhandledRejection", onUnhandled);
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("custom schedule in steady state: reconnecting carries the hook's attempt and delay, one hook call per retry", { timeout: 60_000 }, async () => {
            const calls: number[] = [];
            const { events, onLifecycle } = recorder();
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.hook.steady",
                recovery: {
                    backoff: (attempt) => {
                        calls.push(attempt);
                        return 250 * attempt;
                    },
                },
                lifecycle: { onLifecycle },
            });
            await adapter.connect();
            try {
                const stop = await container.exec(["rabbitmqctl", "stop_app"]);
                assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
                await waitFor(() => events.filter((e) => e.type === "reconnecting").length >= 3, 30_000);
                await restoreBrokerApp();
                await waitFor(() => events.filter((e) => e.type === "connected").length >= 2, 30_000);
                const reconnecting = events.filter((e) => e.type === "reconnecting");
                assert.deepEqual(
                    reconnecting.slice(0, 3).map((e) => [e.attempt, e.delay]),
                    [
                        [1, 250],
                        [2, 500],
                        [3, 750],
                    ],
                );
                assert.deepEqual(calls, reconnecting.map((e) => e.attempt), "the hook is called once per scheduled retry and never to fill the event");
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("attempt restarts at 1 after a successful reconnect", { timeout: 60_000 }, async () => {
            const calls: number[] = [];
            const { events, onLifecycle } = recorder();
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.hook.restart",
                recovery: {
                    backoff: (attempt) => {
                        calls.push(attempt);
                        return 200;
                    },
                },
                lifecycle: { onLifecycle },
            });
            await adapter.connect();
            try {
                // First series: the broker app is down, so the first retry fails and a second one follows.
                const stop = await container.exec(["rabbitmqctl", "stop_app"]);
                assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
                await waitFor(() => calls.includes(2), 30_000);
                await restoreBrokerApp();
                await waitFor(() => events.filter((e) => e.type === "connected").length >= 2, 30_000);
                const firstSeries = [...calls];

                // Second series: a plain drop against a running broker.
                await dropConnections();
                await waitFor(() => events.filter((e) => e.type === "connected").length >= 3, 30_000);

                assert.deepEqual(
                    firstSeries,
                    firstSeries.map((_attempt, index) => index + 1),
                    "the first series counts 1, 2, …",
                );
                assert.ok(firstSeries.length >= 2);
                assert.deepEqual(calls.slice(firstSeries.length), [1], "the series after a successful reconnect starts again at 1");
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("a return value above the default maxDelay is applied and reported unclamped", { timeout: 30_000 }, async () => {
            const { events, onLifecycle } = recorder();
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.hook.unclamped",
                recovery: { backoff: () => 45_000 },
                lifecycle: { onLifecycle },
            });
            await adapter.connect();
            try {
                await dropConnections();
                await waitFor(() => events.some((e) => e.type === "reconnecting"), 10_000);
                assert.equal(events.find((e) => e.type === "reconnecting")?.delay, 45_000);
                // The retry is really 45 s away: nothing reconnects within a few seconds.
                await sleep(2_000);
                assert.equal(events.filter((e) => e.type === "connected").length, 1);
            } finally {
                // disconnect() cancels the pending 45 s retry.
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("zero means an immediate retry, and recovery continues", { timeout: 30_000 }, async () => {
            const { events, onLifecycle } = recorder();
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.hook.zero",
                recovery: { backoff: () => 0 },
                lifecycle: { onLifecycle },
            });
            await adapter.connect();
            try {
                await dropConnections();
                await waitFor(() => events.filter((e) => e.type === "connected").length >= 2, 10_000);
                assert.equal(events.find((e) => e.type === "reconnecting")?.delay, 0);
                assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0);
                await adapter.publish("rec.hook.zero.evt", new Uint8Array([1]));
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("without the hook the built-in delay applies and stays within maxDelay", { timeout: 30_000 }, async () => {
            const { events, onLifecycle } = recorder();
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.hook.default",
                recovery: { initialDelay: 100, maxDelay: 500 },
                lifecycle: { onLifecycle },
            });
            await adapter.connect();
            try {
                await dropConnections();
                await waitFor(() => events.filter((e) => e.type === "connected").length >= 2, 10_000);
                const delay = events.find((e) => e.type === "reconnecting")?.delay;
                // Attempt 1 of the built-in formula: 100 ms ± 20 % jitter.
                assert.ok(delay !== undefined && delay >= 80 && delay <= 120, `built-in delay for attempt 1, got ${delay}`);
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });

    describe("recovery give-up (retry budget exhausted)", () => {
        // A small finite budget with short delays: once the broker app is down
        // every reconnect attempt is refused, so amqplib gives up within about
        // a second. The same budget also bounds amqplib's initial connect, which
        // is why the broker must be fully back before any later connect().
        const GIVE_UP_RECOVERY = { initialDelay: 100, maxDelay: 200, maxRetries: 2 } as const;

        /** Stop the broker app and wait until the adapter reports that recovery gave up. */
        async function driveToGiveUp(events: ReadonlyArray<{ type: string }>): Promise<void> {
            const stop = await container.exec(["rabbitmqctl", "stop_app"]);
            assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
            await waitFor(() => events.some((e) => e.type === "reconnect-failed"), 30_000);
            // Settle window: a second terminal event or a further retry would land here.
            await sleep(300);
            assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 1, "recovery give-up is reported exactly once");
        }

        const isNotConnectedError = (err: unknown): boolean => err instanceof AmqpConnectionError && /not connected/.test(err.message);

        it("subscribe() after give-up rejects with a typed 'not connected' error — no hang, no raw amqplib error", { timeout: 60_000 }, async () => {
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.giveup.sub",
                recovery: GIVE_UP_RECOVERY,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                await driveToGiveUp(events);

                // The rejection itself is asserted below; this only stops the
                // race loser from surfacing as an unhandled rejection.
                const subscribing = adapter.subscribe(["rec.giveup.sub.evt"], async () => undefined);
                subscribing.catch(() => undefined);

                await assert.rejects(
                    () => settleWithin(subscribing, 5_000),
                    (err: unknown) => {
                        assert.ok(isNotConnectedError(err), `expected AmqpConnectionError 'not connected', got: ${String(err)}`);
                        return true;
                    },
                );
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("publish() with publishRetry after give-up rejects at once without spending its retry budget", { timeout: 60_000 }, async () => {
            const events: Array<{ type: string }> = [];
            const retries: number[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.giveup.pub",
                recovery: GIVE_UP_RECOVERY,
                // Ten fixed 500 ms retries: a loop that does not recognise the
                // dead cycle spends about 5 s and fires onRetry ten times, far
                // outside the bounds asserted below.
                publishRetry: { initialDelay: 500, maxDelay: 500, jitter: 0, maxRetries: 10, onRetry: (info) => retries.push(info.attempt) },
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                await driveToGiveUp(events);

                const startedAt = Date.now();
                await assert.rejects(
                    () => adapter.publish("rec.giveup.pub.evt", new Uint8Array([1])),
                    (err: unknown) => {
                        assert.ok(isNotConnectedError(err), `expected AmqpConnectionError 'not connected', got: ${String(err)}`);
                        return true;
                    },
                );
                const took = Date.now() - startedAt;
                assert.deepEqual(retries, [], "no retry is attempted against a cycle that recovery abandoned");
                assert.ok(took < 2_000, `publish must fail fast after give-up (took ${took}ms)`);
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("connect() after give-up starts clean and does not resurrect the subscriptions from before the give-up", { timeout: 90_000 }, async () => {
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.giveup.reconnect",
                recovery: GIVE_UP_RECOVERY,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                // A durable named-group queue survives the app restart, so its
                // consumer count afterwards shows whether the old subscription
                // was replayed by the new connection.
                await adapter.subscribe(["rec.giveup.reconnect.evt"], async (_event, ack) => {
                    await ack();
                }, { group: "g" });

                await driveToGiveUp(events);
                await restoreBrokerApp();

                await adapter.connect();
                // Any resurrected consumer would attach during this window.
                await sleep(500);

                const admin = await connect(url);
                try {
                    const adminCh = await admin.createChannel();
                    const queue = await adminCh.checkQueue("rec.giveup.reconnect.g");
                    assert.equal(queue.consumerCount, 0, "the subscription from before the give-up must not be replayed");
                    await adminCh.close();
                } finally {
                    await admin.close();
                }

                // The fresh cycle is fully usable.
                await adapter.publish("rec.giveup.reconnect.evt", new Uint8Array([1]));
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("a subscribe() waiting for a channel when recovery gives up rejects with a typed error", { timeout: 60_000 }, async () => {
            // Called while recovery is still retrying, subscribe() parks in
            // amqplib's waiter queue. amqplib rejects parked waiters with its
            // last raw connection error (e.g. ECONNRESET/ECONNREFUSED), which
            // the connection-lost text heuristic does not recognise — the
            // public boundary must still surface the typed AmqpConnectionError.
            const events: Array<{ type: string }> = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "rec.giveup.parked",
                recovery: { ...GIVE_UP_RECOVERY, initialDelay: 300, maxDelay: 400 },
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                const stop = await container.exec(["rabbitmqctl", "stop_app"]);
                assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
                await waitFor(() => events.some((e) => e.type === "disconnected"), 30_000);
                assert.ok(!events.some((e) => e.type === "reconnect-failed"), "precondition: recovery has not given up yet");

                const subscribing = adapter.subscribe(["rec.giveup.parked.evt"], async () => undefined);
                subscribing.catch(() => undefined);

                await assert.rejects(
                    () => settleWithin(subscribing, 20_000),
                    (err: unknown) => {
                        assert.ok(err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(err)}`);
                        return true;
                    },
                );
                assert.ok(events.some((e) => e.type === "reconnect-failed"), "the rejection must come from the recovery give-up");
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });

    it("reconnect during subscribe: consumer is replayed and resumes delivery", async () => {
        const lifecycle: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.resub",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
                onDisconnected: () => lifecycle.push("disconnected"),
            },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["rec.resub.evt"],
                async (event, ack) => {
                    received.push(new TextDecoder().decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );

            // Restart BEFORE any message — exercises subscription replay on recovery
            await dropConnections();
            await waitFor(() => lifecycle.includes("disconnected"));
            await waitFor(() => lifecycle.filter((e) => e === "connected").length >= 2);

            await adapter.publish("rec.resub.evt", new TextEncoder().encode("after-resub"));
            await waitFor(() => received.length === 1);

            assert.deepEqual(received, ["after-resub"]);
        } finally {
            await adapter.disconnect();
        }
    });

    it("node restart: rabbitmqctl stop_app/start_app (broker app restart in place) → reconnect + topology re-assert + resume", async () => {
        const lifecycle: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.nodekill",
            exchangeType: "topic",
            recovery: { initialDelay: 200, maxDelay: 1000 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
                onDisconnected: () => lifecycle.push("disconnected"),
            },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["rec.nodekill.evt"],
                async (event, ack) => {
                    received.push(new TextDecoder().decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("rec.nodekill.evt", new TextEncoder().encode("before"));
            await waitFor(() => received.length === 1);

            // Restart the RabbitMQ APP in place (stop_app → start_app): all
            // listeners close and every connection drops — a harder failure than
            // close_all_connections, which keeps the app running — yet the
            // container and its mapped port stay stable, so the adapter's fixed
            // URL still points at the broker when it returns. (A full
            // `container.restart()` would re-map the host port and break the URL.)
            const stop = await container.exec(["rabbitmqctl", "stop_app"]);
            assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
            await waitFor(() => lifecycle.includes("disconnected"), 30_000);
            const start = await container.exec(["rabbitmqctl", "start_app"]);
            assert.equal(start.exitCode, 0, `start_app failed (${start.exitCode}): ${start.output}`);
            await waitFor(() => lifecycle.filter((e) => e === "connected").length >= 2, 60_000);

            // After the app restart, topology was re-asserted and the consumer
            // replayed → publish + consume resume. Retry publish until the app is
            // fully back.
            let publishedAfter = false;
            for (let attempt = 0; attempt < 100 && !publishedAfter; attempt++) {
                try {
                    await adapter.publish("rec.nodekill.evt", new TextEncoder().encode("after"));
                    publishedAfter = true;
                } catch {
                    await sleep(300);
                }
            }
            assert.ok(publishedAfter, "adapter must publish after the broker app restarts");
            await waitFor(() => received.includes("after"), 30_000);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("heartbeat timeout: a frozen broker (short heartbeat) is detected and the adapter reconnects", async () => {
        const lifecycle: string[] = [];
        // Heartbeat is a CONNECTION param (URL query), not a socket option. A
        // short heartbeat makes amqplib's client-side monitor declare the peer
        // dead quickly when no bytes arrive — which is how a silent connection
        // death (frozen broker / network partition) is detected.
        const adapter = AmqpAdapter({
            url: `${url}?heartbeat=2`,
            exchange: "rec.heartbeat",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
                onDisconnected: () => lifecycle.push("disconnected"),
            },
        });
        await adapter.connect();
        const id = container.getId();
        try {
            await waitFor(() => lifecycle.filter((e) => e === "connected").length >= 1);

            // Freeze the broker process: the TCP socket stays open but no bytes
            // (incl. heartbeats) flow, so the client's heartbeat monitor fires.
            // Pause for > 2× heartbeat (4s) so detection happens during the freeze.
            await execFileAsync("docker", ["pause", id]);
            await sleep(7000);
            await execFileAsync("docker", ["unpause", id]);

            // Detected as a disconnect, then recovery reconnects to the (unpaused) broker.
            await waitFor(() => lifecycle.includes("disconnected"), 30_000);
            await waitFor(() => lifecycle.filter((e) => e === "connected").length >= 2, 30_000);

            let publishedAfter = false;
            for (let attempt = 0; attempt < 100 && !publishedAfter; attempt++) {
                try {
                    await adapter.publish("rec.heartbeat.evt", new Uint8Array([1]));
                    publishedAfter = true;
                } catch {
                    await sleep(200);
                }
            }
            assert.ok(publishedAfter, "adapter must publish again after heartbeat-driven reconnect");
        } finally {
            await execFileAsync("docker", ["unpause", id]).catch(() => undefined);
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("handler crash during redelivery: a throwing handler nacks→requeues, succeeds on redelivery (no loss)", async () => {
        const adapter = AmqpAdapter({ url, exchange: "rec.redeliver", exchangeType: "topic", recovery: false });
        await adapter.connect();
        try {
            const attempts: number[] = [];
            let processed: string | undefined;
            await adapter.subscribe(
                ["rec.redeliver.evt"],
                async (event, ack) => {
                    attempts.push(event.attempt);
                    if (event.attempt === 1) {
                        // Crash on first delivery → the adapter nacks with requeue.
                        throw new Error("simulated handler crash on first delivery");
                    }
                    processed = new TextDecoder().decode(event.payload);
                    await ack();
                },
                { group: "g" },
            );

            await adapter.publish("rec.redeliver.evt", new TextEncoder().encode("payload-1"));
            await waitFor(() => processed !== undefined);

            // First delivery (attempt 1) crashed → requeued → redelivered as
            // attempt 2 (AMQP `redelivered` flag) → succeeded. The message is not lost.
            assert.deepEqual(attempts, [1, 2]);
            assert.equal(processed, "payload-1");
        } finally {
            await adapter.disconnect();
        }
    });

    it("publishTimeoutMs: frozen broker (no confirm) rejects with AmqpPublishTimeoutError", async () => {
        // Freeze the broker process (docker pause): the TCP connection stays
        // up but no confirm is ever delivered, so publishTimeoutMs fires
        // deterministically — unlike a fast live broker, which confirms first.
        const adapter = AmqpAdapter({ url, exchange: "rec.timeout", recovery: false, publishTimeoutMs: 500 });
        await adapter.connect();
        const id = container.getId();
        try {
            await execFileAsync("docker", ["pause", id]);
            try {
                await assert.rejects(
                    () => adapter.publish("rec.timeout.evt", new Uint8Array([1])),
                    (err: unknown) => err instanceof AmqpPublishTimeoutError,
                );
            } finally {
                await execFileAsync("docker", ["unpause", id]);
            }
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("failFastOnInitialSetupError: a permanent topology error rejects connect() instead of hanging", { timeout: 20_000 }, async () => {
        // Pre-declare a queue with one argument via a throwaway connection.
        const pre = await connect(url);
        const pch = await pre.createChannel();
        await pch.assertQueue("rec.ff.q", { durable: true, arguments: { "x-max-length": 100 } });
        await pch.close();
        await pre.close();

        const setupFailures: Array<{ initial: boolean; attempt: number }> = [];
        // recovery ENABLED (default) + flag: must reject FAST via the typed error,
        // not hang forever in amqplib's infinite recovery loop.
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.ff",
            exchangeType: "direct",
            failFastOnInitialSetupError: true,
            topology: { queues: [{ name: "rec.ff.q", durable: true, arguments: { "x-max-length": 999 } }] },
            lifecycle: { onSetupFailed: (_e, ctx) => setupFailures.push({ ...ctx }) },
        });

        await assert.rejects(
            () => adapter.connect(),
            (err: unknown) => err instanceof AmqpTopologyError,
        );
        assert.deepEqual(setupFailures, [{ initial: true, attempt: 0 }]);
        await adapter.disconnect().catch(() => undefined);
    });

    it("failFastOnInitialSetupError: valid topology still connects and publishes (probe does not break the happy path)", { timeout: 20_000 }, async () => {
        const setupFailures: unknown[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.ff.ok",
            exchangeType: "topic",
            failFastOnInitialSetupError: true,
            lifecycle: { onSetupFailed: (e) => setupFailures.push(e) },
        });
        await adapter.connect();
        try {
            // The probe nulled publishChannel; the real recovering connect must
            // have re-created it, so publish works end-to-end.
            await adapter.publish("rec.ff.ok.evt", new TextEncoder().encode("hello"));
            assert.equal(setupFailures.length, 0);
        } finally {
            await adapter.disconnect();
        }
    });

    it("amqplib pin: an outstanding confirm is rejected with 'channel closed' on connection loss", { timeout: 20_000 }, async () => {
        // A5: the classifier's text fallback depends on this exact amqplib wording.
        const raw = await connect(url);
        // Swallow the socket-loss error we deliberately induce (raw + underlying connection).
        (raw as unknown as EventEmitter).on("error", () => undefined);
        const conn = (raw as unknown as { connection: EventEmitter & { stream: { destroy: (err?: Error) => void } } }).connection;
        conn.on("error", () => undefined);
        try {
            const ch = await raw.createConfirmChannel();
            ch.on("error", () => undefined);
            await ch.assertQueue("rec.pin.drop", { durable: true });

            const confirmErr = new Promise<Error | null>((resolve) => {
                ch.sendToQueue("rec.pin.drop", Buffer.from("x"), { persistent: true }, (err) => resolve(err ?? null));
            });
            // Destroy the socket in the SAME tick as the publish: the broker confirm
            // cannot have round-tripped yet, so the confirm is outstanding and amqplib
            // drains it with Error("channel closed") — deterministic, with no race
            // against a fast localhost broker. (wrapStream returns the raw Duplex
            // socket; destroy(err) emits 'error', which amqplib's onSocketError
            // handler — stream.on('error') at connection.js:214 — reacts to, unlike a
            // bare destroy() that only emits 'close'.)
            conn.stream.destroy(new Error("test: forced socket loss"));

            const err = await confirmErr;
            assert.ok(err instanceof Error, "the outstanding confirm must be rejected on socket loss");
            assert.ok(isConnectionLostError(err), `amqplib drop wording changed (classifier fallback would miss it): ${err.message}`);
        } finally {
            await raw.close().catch(() => undefined);
        }
    });

    it("amqplib pin: an over-capacity queue nacks the publish with 'message nacked' (NOT a connection loss)", { timeout: 20_000 }, async () => {
        // A5: a genuine nack must NOT match the connection-lost fallback regex.
        const raw = await connect(url);
        (raw as unknown as EventEmitter).on("error", () => undefined);
        try {
            const ch = await raw.createConfirmChannel();
            // Exclusive (not transient non-exclusive, which RabbitMQ 4 deprecates →
            // 541 INTERNAL_ERROR): auto-removed when this connection closes.
            const q = "rec.pin.nack";
            await ch.assertQueue(q, { exclusive: true, arguments: { "x-max-length": 1, "x-overflow": "reject-publish" } });

            // First message fills the queue (length 1, no consumer).
            await new Promise<void>((resolve, reject) => {
                ch.sendToQueue(q, Buffer.from("1"), {}, (err) => (err ? reject(err) : resolve()));
            });
            // Second exceeds max-length with reject-publish → broker nacks it.
            const nackErr = await new Promise<Error | null>((resolve) => {
                ch.sendToQueue(q, Buffer.from("2"), {}, (err) => resolve(err ?? null));
            });

            assert.ok(nackErr instanceof Error, "over-capacity publish must be nacked");
            assert.match(nackErr.message, /message nacked/i, "amqplib nack wording changed");
            assert.equal(isConnectionLostError(nackErr), false, "a nack must not be misclassified as a connection loss");
        } finally {
            await raw.close().catch(() => undefined);
        }
    });
});

/**
 * Network-partition recovery via Toxiproxy. The adapter connects to the broker
 * THROUGH a Toxiproxy proxy on a shared network; disabling the proxy severs the
 * network path (the broker stays up) and re-enabling it heals the partition.
 * This is a distinct fault from the in-process suite above: the broker never
 * goes down — only the link between the adapter and the broker is cut.
 */
describe("AMQP network partition (Toxiproxy)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let network: StartedNetwork;
    let rabbit: StartedTestContainer;
    let toxiproxy: StartedToxiProxyContainer;
    let proxy: CreatedProxy;
    let url: string;

    before(async () => {
        network = await new Network().start();
        rabbit = await new GenericContainer("rabbitmq:4-alpine").withNetwork(network).withNetworkAliases("rabbitmq").withExposedPorts(5672).start();
        toxiproxy = await new ToxiProxyContainer("ghcr.io/shopify/toxiproxy:2.5.0").withNetwork(network).start();
        // The proxy forwards to the broker over the shared network; the adapter
        // dials the proxy's host-mapped endpoint, so toggling the proxy controls
        // the adapter↔broker link without touching the broker.
        proxy = await toxiproxy.createProxy({ name: "rabbit", upstream: "rabbitmq:5672" });
        url = `amqp://guest:guest@${proxy.host}:${proxy.port}`;
    });

    after(async () => {
        await toxiproxy?.stop().catch(() => undefined);
        await rabbit?.stop().catch(() => undefined);
        await network?.stop().catch(() => undefined);
    });

    it("lifecycle exactly-once under a socket-level cut: disconnected once per partition (#197)", { timeout: 90_000 }, async () => {
        const events: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.partition197",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => events.push("connected"),
                onDisconnected: () => events.push("disconnected"),
            },
        });
        await adapter.connect();
        try {
            assert.equal(events.filter((e) => e === "connected").length, 1, "initial connect fires onConnected exactly once");

            // Sever the link at the socket level: unlike a graceful server
            // close (close_all_connections → clean connection.close), a killed
            // socket makes the model emit 'error' AND 'close' — the path where
            // a double onDisconnected can hide.
            await proxy.setEnabled(false);
            await waitFor(() => events.includes("disconnected"), 30_000);
            await proxy.setEnabled(true);
            await waitFor(() => events.filter((e) => e === "connected").length >= 2, 30_000);
            // Settle window: let any late duplicate disconnected land before counting.
            await sleep(500);

            assert.equal(events.filter((e) => e === "connected").length, 2, "reconnect fires onConnected exactly once");
            assert.equal(
                events.filter((e) => e === "disconnected").length,
                1,
                "a socket-level cut fires onDisconnected exactly once (no error+disconnect double-fire)",
            );
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("recovery.backoff sets the initial-window schedule: reconnecting 1, 2, 3 with 250, 500, 750 ms, and the waits match", { timeout: 60_000 }, async () => {
        const calls: number[] = [];
        const events: Array<{ type: string; attempt?: number; delay?: number; at: number }> = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.hook.initial",
            recovery: {
                initialConnectMaxRetries: 5,
                backoff: (attempt) => {
                    calls.push(attempt);
                    return 250 * attempt;
                },
            },
            lifecycle: {
                onLifecycle: (event) => {
                    events.push({
                        type: event.type,
                        ...("attempt" in event ? { attempt: event.attempt } : {}),
                        ...("delay" in event ? { delay: event.delay } : {}),
                        at: Date.now(),
                    });
                },
            },
        });
        // The broker is unreachable through the proxy until three retries were scheduled.
        await proxy.setEnabled(false);
        // Re-applying the proxy config drops the connections through it, so
        // the cleanup re-enables it only if the test body did not.
        let proxyDisabled = true;
        try {
            const connecting = adapter.connect();
            connecting.catch(() => undefined);
            await waitFor(() => events.filter((e) => e.type === "reconnecting").length >= 3, 20_000);
            await proxy.setEnabled(true);
            proxyDisabled = false;
            await settleWithin(connecting, 20_000);

            const reconnecting = events.filter((e) => e.type === "reconnecting");
            assert.deepEqual(
                reconnecting.slice(0, 3).map((e) => [e.attempt, e.delay]),
                [
                    [1, 250],
                    [2, 500],
                    [3, 750],
                ],
            );
            // The wait is measured from a scheduled retry to the next one: it
            // spans the delay plus one refused connection attempt through the proxy.
            for (const index of [0, 1]) {
                const scheduled = reconnecting[index] as { at: number; delay: number };
                const next = reconnecting[index + 1] as { at: number };
                const waited = next.at - scheduled.at;
                assert.ok(waited >= scheduled.delay - 20 && waited <= scheduled.delay + 1_000, `wait after retry ${index + 1}: ${waited} ms for a ${scheduled.delay} ms delay`);
            }
            assert.deepEqual(calls, reconnecting.map((e) => e.attempt), "one hook call per scheduled retry");
            assert.deepEqual(
                events.filter((e) => e.type === "connected").map((e) => e.type),
                ["connected"],
            );
        } finally {
            if (proxyDisabled) {
                await proxy.setEnabled(true);
            }
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("network cut (Toxiproxy proxy disabled) → reconnect when the network heals", async () => {
        const lifecycle: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange: "rec.partition",
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
                onDisconnected: () => lifecycle.push("disconnected"),
            },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["rec.partition.evt"],
                async (event, ack) => {
                    received.push(new TextDecoder().decode(event.payload));
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("rec.partition.evt", new TextEncoder().encode("before"));
            await waitFor(() => received.length === 1);

            // Sever the adapter↔broker network path (broker stays up).
            await proxy.setEnabled(false);
            await waitFor(() => lifecycle.includes("disconnected"), 30_000);

            // Heal the partition — recovery reconnects, re-asserts topology, and
            // replays the consumer.
            await proxy.setEnabled(true);
            await waitFor(() => lifecycle.filter((e) => e === "connected").length >= 2, 30_000);

            let publishedAfter = false;
            for (let attempt = 0; attempt < 100 && !publishedAfter; attempt++) {
                try {
                    await adapter.publish("rec.partition.evt", new TextEncoder().encode("after"));
                    publishedAfter = true;
                } catch {
                    await sleep(200);
                }
            }
            assert.ok(publishedAfter, "adapter must publish again after the partition heals");
            await waitFor(() => received.includes("after"), 20_000);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });
});

/**
 * Connection-recovery integration tests using testcontainers.
 *
 * Unlike amqp-broker.test.ts (which only needs a reachable broker), these
 * scenarios drop client connections at the broker mid-test, so they manage a
 * RabbitMQ container programmatically (`container.exec` → rabbitmqctl). Gated
 * behind RUN_RECOVERY_TESTS=1 (set in the non-blocking CI job) so a plain
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
        const events: Array<{ type: string; attempt?: number; delay?: number }> = [];
        const adapter = AmqpAdapter({
            // Nothing listens on port 1 — every attempt is a fast ECONNREFUSED.
            url: "amqp://guest:guest@127.0.0.1:1",
            exchange: "rec.bounded198",
            recovery: { initialDelay: 50, maxDelay: 100, initialConnectMaxRetries: 2 },
            lifecycle: {
                onLifecycle: (event) => events.push(event),
            },
        });

        await assert.rejects(
            () => adapter.connect(),
            (err: unknown) => {
                assert.ok(err instanceof AmqpConnectionError, "budget exhaustion rejects typed");
                assert.ok((err as Error).message.includes("initialConnectMaxRetries: 2"));
                assert.ok((err as { cause?: unknown }).cause instanceof Error, "the last attempt's failure is the cause");
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
        assert.equal(events.filter((e) => e.type === "connected").length, 0);
        await adapter.disconnect().catch(() => undefined);
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

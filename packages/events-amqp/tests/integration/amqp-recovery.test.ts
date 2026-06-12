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
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpPublishTimeoutError, AmqpTopologyError } from "../../src/errors.ts";

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
            // Any rejection must be a typed connection/timeout error, never a raw hang or untyped throw
            for (const r of results) {
                if (!r.ok) {
                    assert.ok(
                        r.err instanceof AmqpConnectionError || r.err instanceof AmqpPublishTimeoutError,
                        `unexpected rejection type: ${r.err}`,
                    );
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
            (err: unknown) => err instanceof AmqpTopologyError,
        );
        await adapter.disconnect().catch(() => undefined);
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
});

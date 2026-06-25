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
import { AmqpConnectionError, AmqpPublishTimeoutError, AmqpTopologyError } from "../../src/errors.ts";

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

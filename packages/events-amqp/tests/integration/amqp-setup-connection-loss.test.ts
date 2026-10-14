/**
 * A connection lost while the topology setup pass runs.
 *
 * `AmqpTopologyError` means "the broker answered a declare, check or bind with
 * a refusal, or the configuration is invalid", and it is the only class the
 * fail-fast gates act on. A connection that drops in the middle of the pass
 * rejects the pending request and every later send, which the topology
 * wrappers used to report as `AmqpTopologyError` too: with
 * `failFastOnInitialSetupError` that rejected `connect()` although the broker
 * had said nothing wrong, and a `setup-failed` event reported a topology fault
 * that never happened.
 *
 * The drop is made deterministic by a TCP proxy that destroys one connection
 * the moment the client sends its first `exchange.declare` / `queue.declare`,
 * so the pass is always interrupted at the same point and no test sleeps to
 * win a race. Broker refusals (404, 406) still have to fail fast; they are the
 * control group.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a
 * broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type amqp from "amqplib";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";
import { type CuttingProxy, startCuttingProxy } from "./cuttingProxy.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(25);
    }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (payload: Uint8Array): string => new TextDecoder().decode(payload);

describe("AMQP connection lost during the setup pass (broker)", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokerUrl = AMQP_URL as string;
    let proxy: CuttingProxy;
    let proxyUrl: string;
    const created: Array<{ exchange: string; queues: string[] }> = [];

    before(async () => {
        const parsed = new URL(brokerUrl);
        proxy = await startCuttingProxy({ host: parsed.hostname, port: Number(parsed.port || 5672) });
        // The path carries the virtual host and the query carries connection parameters:
        // both are kept as the broker URL spells them, only the address is replaced.
        proxyUrl = `amqp://${parsed.username}:${parsed.password}@127.0.0.1:${proxy.port}${parsed.pathname}${parsed.search}`;
    });

    after(async () => {
        await proxy?.close();
        const conn = await connect(brokerUrl);
        try {
            // A refused deletion (for example of a queue that was never created) closes its
            // channel, so every deletion runs on a channel of its own: a later one is never
            // skipped because an earlier one failed.
            const remove = async (op: (ch: amqp.Channel) => Promise<unknown>): Promise<void> => {
                const ch = await conn.createChannel();
                try {
                    await op(ch);
                } catch {
                    // already absent
                } finally {
                    await ch.close().catch(() => undefined);
                }
            };
            for (const entry of created) {
                for (const queue of entry.queues) {
                    await remove((ch) => ch.deleteQueue(queue));
                }
                await remove((ch) => ch.deleteExchange(entry.exchange));
            }
        } finally {
            await conn.close();
        }
    });

    function uniqueExchange(label: string): { exchange: string; queue: string } {
        const exchange = `setuploss.${label}.${randomUUID().slice(0, 8)}`;
        const queue = `${exchange}.g`;
        created.push({ exchange, queues: [queue] });
        return { exchange, queue };
    }

    async function assertRoundTrip(adapter: ReturnType<typeof AmqpAdapter>, exchange: string): Promise<void> {
        const received: string[] = [];
        await adapter.subscribe(
            [`${exchange}.evt`],
            async (event, ack) => {
                received.push(decode(event.payload));
                await ack();
            },
            { group: "g" },
        );
        await adapter.publish(`${exchange}.evt`, encode("after-loss"));
        await waitFor(() => received.length === 1);
        assert.deepEqual(received, ["after-loss"]);
    }

    it("failFastOnInitialSetupError: a drop during the startup probe does not reject connect() and emits no setup-failed", { timeout: 60_000 }, async () => {
        const { exchange } = uniqueExchange("probe");
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url: proxyUrl,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 50, maxDelay: 200 },
            failFastOnInitialSetupError: true,
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        proxy.armCutAtNextDeclare();
        try {
            await adapter.connect();
            assert.equal(proxy.cuts(), 1, "the probe's first declare was interrupted");
            assert.equal(
                events.filter((e) => e.type === "setup-failed").length,
                0,
                "a lost connection is not a topology fault",
            );
            assert.ok(
                events.some((e) => e.type === "connected"),
                "the recovering connect completed after the probe was lost",
            );
            await assertRoundTrip(adapter, exchange);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("failFastOnInitialSetupError with initialConnectMaxRetries: a drop in the first attempt is a transient failure that is retried", { timeout: 60_000 }, async () => {
        const { exchange } = uniqueExchange("budget");
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url: proxyUrl,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 50, maxDelay: 200, initialConnectMaxRetries: 2 },
            failFastOnInitialSetupError: true,
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        proxy.armCutAtNextDeclare();
        try {
            await adapter.connect();
            assert.equal(proxy.cuts(), 1, "the first attempt's first declare was interrupted");
            const reconnecting = events.filter((e) => e.type === "reconnecting");
            assert.deepEqual(
                reconnecting.map((e) => e.attempt),
                [1],
                "the lost attempt is counted as one transient failure",
            );
            assert.equal(events.filter((e) => e.type === "setup-failed").length, 0, "no topology fault is reported");
            assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0, "the budget is not exhausted");
            await assertRoundTrip(adapter, exchange);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("steady state: a drop during the recovery setup keeps recovering, emits no setup-failed, and ends connected", { timeout: 60_000 }, async () => {
        const { exchange } = uniqueExchange("steady");
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url: proxyUrl,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 50, maxDelay: 200 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            // The next connection the adapter opens (the recovery one) is cut at its first declare.
            proxy.armCutAtNextDeclare();
            proxy.dropAll();

            await waitFor(() => events.some((e) => e.type === "connected" && e.reconnected));
            assert.equal(proxy.cuts(), 1, "the recovery setup was interrupted once");
            assert.ok(
                events.some((e) => e.type === "reconnecting"),
                "the lost setup pass scheduled another attempt",
            );
            assert.equal(events.filter((e) => e.type === "setup-failed").length, 0, "no topology fault is reported");
            assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0);
            await assertRoundTrip(adapter, exchange);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    describe("broker refusals still fail fast under failFastOnInitialSetupError", () => {
        it("404 on a missing queue in check mode rejects connect() with AmqpTopologyError after one setup-failed", { timeout: 30_000 }, async () => {
            const { exchange, queue } = uniqueExchange("refuse404");
            // The exchange exists, the topology-declared queue does not.
            const conn = await connect(brokerUrl);
            try {
                const ch = await conn.createChannel();
                await ch.assertExchange(exchange, "topic", { durable: false });
            } finally {
                await conn.close();
            }
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url: proxyUrl,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                topology: { queues: [{ name: queue, durable: false }] },
                topologyMode: "check",
                failFastOnInitialSetupError: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                await assert.rejects(() => adapter.connect(), AmqpTopologyError);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["setup-failed"],
                    "the refusal is reported as a topology fault, once",
                );
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("403 on an exchange name with the reserved amq. prefix rejects connect() with AmqpTopologyError after one setup-failed", { timeout: 30_000 }, async () => {
            const exchange = `amq.setuploss.${randomUUID().slice(0, 8)}`;
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url: proxyUrl,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                failFastOnInitialSetupError: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                await assert.rejects(
                    () => adapter.connect(),
                    (err: unknown) => {
                        assert.ok(err instanceof AmqpTopologyError);
                        assert.equal((err.cause as { code?: number } | undefined)?.code, 403, "the broker refused with ACCESS_REFUSED");
                        return true;
                    },
                );
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["setup-failed"],
                    "the refusal is reported as a topology fault, once",
                );
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("406 on an exchange redeclared with another type rejects connect() with AmqpTopologyError after one setup-failed", { timeout: 30_000 }, async () => {
            const { exchange } = uniqueExchange("refuse406");
            const conn = await connect(brokerUrl);
            try {
                const ch = await conn.createChannel();
                await ch.assertExchange(exchange, "direct", { durable: false });
            } finally {
                await conn.close();
            }
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url: proxyUrl,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                failFastOnInitialSetupError: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                await assert.rejects(() => adapter.connect(), AmqpTopologyError);
                assert.deepEqual(
                    events.map((e) => e.type),
                    ["setup-failed"],
                    "the refusal is reported as a topology fault, once",
                );
            } finally {
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });
});

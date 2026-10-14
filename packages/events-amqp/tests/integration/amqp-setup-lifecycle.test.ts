/**
 * Setup and connection-lifecycle contracts against a live RabbitMQ
 * (testcontainers).
 *
 * What the reliability guide and the release notes promise about the topology
 * setup pass and the lifecycle events, checked against the broker's real
 * replies and flow control rather than synthetic errors:
 *
 * - a setup that fails with `recovery: false` rejects `connect()` and does not
 *   report `disconnected` for the connection the adapter discards itself;
 * - a broker drop while the startup probe runs does not raise an unhandled
 *   `error` event (the process would crash);
 * - the attempt counter of `setup-failed { initial: false }` starts at 1 in a
 *   new `connect()` after recovery gave up;
 * - `onLifecycle` alone enables the startup probe;
 * - a binding with no destination is rejected without `AmqpTopologyError.object`,
 *   a binding the broker refuses carries it;
 * - `treatTopologyErrorAsFatal` stops recovery on a live `406 inequivalent arg`
 *   and keeps retrying on a live `406` exchange-limit reply;
 * - `blocked` / `unblocked` follow the broker's flow control.
 *
 * Gated behind RUN_RECOVERY_TESTS=1 like the other container suites. Every
 * setting the tests change on the broker is restored in a `finally`, because
 * the broker is shared by all tests of this file.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type amqp from "amqplib";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter, isDeterministicTopologyDrift } from "../../src/AmqpAdapter.ts";
import { AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";
import { startCuttingProxy } from "./cuttingProxy.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(25);
    }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const uniqueName = (label: string): string => `lifecycle.${label}.${randomUUID().slice(0, 8)}`;

describe("AMQP setup and lifecycle contracts (testcontainers)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;

    async function ctl(...args: string[]): Promise<string> {
        const res = await container.exec(["rabbitmqctl", "-q", ...args], { user: "rabbitmq" });
        if (res.exitCode !== 0) {
            throw new Error(`rabbitmqctl ${args.join(" ")} failed (${res.exitCode}): ${res.output}`);
        }
        return res.output;
    }

    /** Force-close every client connection at the broker; the broker itself stays up. */
    async function dropConnections(): Promise<void> {
        await ctl("close_all_connections", "lifecycle-test-drop");
    }

    /** Run `fn` on a short-lived administrative connection and channel. */
    async function admin<T>(fn: (ch: amqp.Channel) => Promise<T>): Promise<T> {
        const conn = await connect(url);
        try {
            const ch = await conn.createChannel();
            try {
                return await fn(ch);
            } finally {
                await ch.close().catch(() => undefined);
            }
        } finally {
            await conn.close().catch(() => undefined);
        }
    }

    /** Wait until the broker app accepts AMQP connections. */
    async function waitForBroker(): Promise<void> {
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
        container = await new GenericContainer(RABBITMQ_IMAGE).withExposedPorts(5672).start();
        url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
        await waitForBroker();
    });

    after(async () => {
        await container?.stop();
    });

    describe("a setup that fails", () => {
        it("recovery: false: connect() rejects and the adapter-discarded connection is not reported as disconnected", { timeout: 30_000 }, async () => {
            const exchange = uniqueName("norec.fail");
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: false,
                // Check mode only verifies existence: the exchange is missing, so the setup fails with a 404.
                topologyMode: "check",
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            try {
                await assert.rejects(
                    () => adapter.connect(),
                    (err: unknown) => err instanceof AmqpTopologyError,
                    "the failed setup surfaces as the thrown error",
                );

                // Heal the cause and connect again: the only events of the whole
                // run must be this connect's `connected`. A `disconnected` for
                // the discarded connection of the first attempt would sit in
                // front of it.
                await admin((ch) => ch.assertExchange(exchange, "topic", { durable: true }));
                await adapter.connect();
                assert.deepEqual(
                    events.map((event) => event.type),
                    ["connected"],
                    "the connection the adapter discarded itself is not a loss",
                );
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
            }
        });
    });

    describe("the startup probe", () => {
        it("a broker drop while the probe runs its setup pass raises no unhandled error event", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("probe.drop");
            const events: AmqpLifecycleEvent[] = [];
            const uncaught: unknown[] = [];
            const onUncaught = (err: unknown): void => {
                uncaught.push(err);
            };
            const proxy = await startCuttingProxy({ host: container.getHost(), port: container.getMappedPort(5672) });
            const proxyUrl = `amqp://guest:guest@127.0.0.1:${proxy.port}`;
            const adapter = AmqpAdapter({
                url: proxyUrl,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                failFastOnInitialSetupError: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            process.on("uncaughtException", onUncaught);
            try {
                // The probe is the first connection of connect(); the proxy
                // destroys it the moment it sends its first declare.
                proxy.armCutAtNextDeclare();
                await adapter.connect();

                assert.equal(proxy.cuts(), 1, "the probe's first declare was interrupted");
                // An unhandled `error` event surfaces asynchronously from the socket handler:
                // let the event loop turn once more before judging.
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.deepEqual(uncaught, [], "the dropped probe connection must not crash the process");
                assert.equal(events.filter((e) => e.type === "setup-failed").length, 0, "a lost connection is not a topology fault");
                assert.ok(
                    events.some((e) => e.type === "connected" && !e.reconnected),
                    "connect() completed on the recovering connection after the probe was lost",
                );
            } finally {
                process.off("uncaughtException", onUncaught);
                await adapter.disconnect().catch(() => undefined);
                await proxy.close();
                await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
            }
        });

        it("onLifecycle alone enables the probe: a missing exchange is reported as setup-failed { initial: true, attempt: 0 } and connect() heals", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("probe.lifecycle");
            const events: AmqpLifecycleEvent[] = [];
            // No failFastOnInitialSetupError and no onSetupFailed: the lifecycle callback is the only opt-in.
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                topologyMode: "check",
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            let connecting: Promise<void> | undefined;
            try {
                connecting = adapter.connect();
                // Without fail-fast the startup keeps retrying: observe the probe's report, then remove its cause.
                await waitFor(() => events.some((e) => e.type === "setup-failed"));
                const first = events.find((e) => e.type === "setup-failed");
                assert.ok(first?.type === "setup-failed");
                assert.equal(first.initial, true);
                assert.equal(first.attempt, 0, "the probe reports attempt 0");
                assert.ok(first.error instanceof AmqpTopologyError);

                await admin((ch) => ch.assertExchange(exchange, "topic", { durable: true }));
                await connecting;
                assert.equal(events.filter((e) => e.type === "connected").length, 1);
            } finally {
                // Make the pending connect() succeed before disconnect() whatever the outcome above was.
                await admin((ch) => ch.assertExchange(exchange, "topic", { durable: true })).catch(() => undefined);
                await connecting?.catch(() => undefined);
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
            }
        });
    });

    describe("a binding declaration", () => {
        for (const variant of [
            { label: "recovery: false", extra: { recovery: false as const } },
            { label: "recovery with the startup probe", extra: { failFastOnInitialSetupError: true } },
        ]) {
            it(`without a destination is rejected by AmqpTopologyError without an own 'object' key, ${variant.label}`, { timeout: 30_000 }, async () => {
                const exchange = uniqueName("binding.nodest");
                const adapter = AmqpAdapter({
                    url,
                    exchange,
                    exchangeType: "topic",
                    topology: { bindings: [{ source: exchange, routingKey: "k" }] },
                    ...variant.extra,
                });
                try {
                    const error = await adapter.connect().then(
                        () => undefined,
                        (err: unknown) => err,
                    );
                    assert.ok(error instanceof AmqpTopologyError);
                    assert.equal(Object.hasOwn(error, "object"), false, "no own 'object' key: the missing destination is exactly what an identity would need");
                    assert.equal(error.object, undefined);
                } finally {
                    await adapter.disconnect().catch(() => undefined);
                    await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
                }
            });
        }

        it("the broker refuses carries its identity in AmqpTopologyError.object", { timeout: 30_000 }, async () => {
            const exchange = uniqueName("binding.refused");
            const missingQueue = `${exchange}.missing`;
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: false,
                topology: { bindings: [{ queue: missingQueue, source: exchange, routingKey: "k" }] },
            });
            try {
                const error = await adapter.connect().then(
                    () => undefined,
                    (err: unknown) => err,
                );
                assert.ok(error instanceof AmqpTopologyError);
                assert.deepEqual(error.object, { kind: "binding", source: exchange, destination: missingQueue, destinationType: "queue", routingKey: "k" });
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
            }
        });
    });

    describe("treatTopologyErrorAsFatal against the broker's real 406 replies", () => {
        it("a queue redeclared with other arguments (inequivalent arg) stops recovery after one setup-failed", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("fatal.ineq");
            const queue = `${exchange}.q`;
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                topology: { queues: [{ name: queue, durable: true, arguments: { "x-max-length": 100 } }] },
                treatTopologyErrorAsFatal: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                // The queue now exists with different arguments: asserting it again is a 406.
                await admin(async (ch) => {
                    await ch.deleteQueue(queue);
                    await ch.assertQueue(queue, { durable: true, arguments: { "x-max-length": 999 } });
                });
                await dropConnections();
                await waitFor(() => events.some((e) => e.type === "reconnect-failed"));

                const failure = events.find((e) => e.type === "setup-failed");
                assert.ok(failure?.type === "setup-failed");
                assert.equal(failure.initial, false);
                const cause = failure.error.cause as { code?: number; message?: string };
                assert.equal(cause.code, 406);
                assert.match(String(cause.message), /inequivalent arg/);
                assert.equal(isDeterministicTopologyDrift(failure.error), true, "the live reply is classified as deterministic drift");

                // Settle window: a retry would add another setup-failed or reconnecting.
                const reconnectingAtStop = events.filter((e) => e.type === "reconnecting").length;
                await sleep(500);
                assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 1, "terminal reconnect-failed fires exactly once");
                assert.equal(events.filter((e) => e.type === "setup-failed").length, 1, "no retry after the fatal stop");
                assert.equal(events.filter((e) => e.type === "reconnecting").length, reconnectingAtStop);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await admin(async (ch) => {
                    await ch.deleteQueue(queue);
                    await ch.deleteExchange(exchange);
                }).catch(() => undefined);
            }
        });

        it("an exchange refused with 'exchange limit reached' keeps recovering and heals when the limit is lifted", { timeout: 60_000 }, async () => {
            const exchange = uniqueName("fatal.limit");
            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 200 },
                treatTopologyErrorAsFatal: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                // The exchange vanishes and the cluster-wide exchange limit rejects any new one:
                // the recovery setup has to declare it again and is refused with a 406.
                await admin((ch) => ch.deleteExchange(exchange));
                await ctl("eval", "application:set_env(rabbit, cluster_exchange_limit, 1).");
                await dropConnections();

                // Two refusals show the retry; a terminal event would end the wait early and fail the assertions below.
                await waitFor(() => events.filter((e) => e.type === "setup-failed").length >= 2 || events.some((e) => e.type === "reconnect-failed"));
                const refusals = events.filter((e) => e.type === "setup-failed");
                for (const refusal of refusals) {
                    assert.ok(refusal.type === "setup-failed");
                    const cause = refusal.error.cause as { code?: number; message?: string };
                    assert.equal(cause.code, 406);
                    assert.match(String(cause.message), /exchange limit of \d+ is reached/);
                    assert.equal(isDeterministicTopologyDrift(refusal.error), false, "the limit clears on its own: not deterministic drift");
                }
                assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0, "recovery was not stopped");

                await ctl("eval", "application:unset_env(rabbit, cluster_exchange_limit).");
                await waitFor(() => events.some((e) => e.type === "connected" && e.reconnected));
                assert.equal(events.filter((e) => e.type === "reconnect-failed").length, 0);
                await adapter.publish(`${exchange}.evt`, encode("after-limit"));
            } finally {
                await ctl("eval", "application:unset_env(rabbit, cluster_exchange_limit).").catch(() => undefined);
                await adapter.disconnect().catch(() => undefined);
                await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
            }
        });
    });

    describe("blocked and unblocked", () => {
        for (const variant of [
            { label: "with recovery", recovery: undefined },
            { label: "with recovery: false", recovery: false as const },
        ]) {
            it(`follow the broker's memory alarm, ${variant.label}`, { timeout: 60_000 }, async () => {
                const exchange = uniqueName("flow");
                const events: AmqpLifecycleEvent[] = [];
                const adapter = AmqpAdapter({
                    url,
                    exchange,
                    exchangeType: "topic",
                    ...(variant.recovery === undefined ? {} : { recovery: variant.recovery }),
                    lifecycle: { onLifecycle: (event) => events.push(event) },
                });
                await adapter.connect();
                let publishing: Promise<void> | undefined;
                try {
                    // The broker blocks a connection that publishes while an alarm is raised.
                    await ctl("set_vm_memory_high_watermark", "0.0001");
                    publishing = adapter.publish(`${exchange}.evt`, encode("under-alarm"));
                    await waitFor(() => events.some((e) => e.type === "blocked"));
                    const blocked = events.find((e) => e.type === "blocked");
                    assert.ok(blocked?.type === "blocked");
                    assert.match(blocked.reason, /memory/i, "the reason is the broker's own text for the alarm");
                    assert.equal(
                        events.some((e) => e.type === "unblocked"),
                        false,
                        "still blocked while the alarm stands",
                    );

                    await ctl("set_vm_memory_high_watermark", "0.4");
                    await waitFor(() => events.some((e) => e.type === "unblocked"));
                    await publishing;

                    const order = events.map((e) => e.type).filter((type) => type === "blocked" || type === "unblocked");
                    assert.deepEqual(order, ["blocked", "unblocked"]);
                } finally {
                    await ctl("set_vm_memory_high_watermark", "0.4").catch(() => undefined);
                    await publishing?.catch(() => undefined);
                    await adapter.disconnect().catch(() => undefined);
                    await admin((ch) => ch.deleteExchange(exchange)).catch(() => undefined);
                }
            });
        }
    });

    describe("setup-failed numbering after recovery gave up", () => {
        it("a new connect() starts the attempt counter of setup-failed { initial: false } at 1", { timeout: 90_000 }, async () => {
            const exchange = uniqueName("renumber");
            const queue = `${exchange}.q`;
            await admin(async (ch) => {
                await ch.assertExchange(exchange, "topic", { durable: true });
                await ch.assertQueue(queue, { durable: true });
            });

            const events: AmqpLifecycleEvent[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                // A small finite budget: with the broker app stopped recovery gives up within about a second.
                recovery: { initialDelay: 100, maxDelay: 200, maxRetries: 2 },
                topology: { queues: [{ name: queue, durable: true }] },
                topologyMode: "check",
                treatTopologyErrorAsFatal: true,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await adapter.connect();
            try {
                await ctl("stop_app");
                await waitFor(() => events.some((e) => e.type === "reconnect-failed"));
                assert.ok(
                    events.some((e) => e.type === "reconnecting"),
                    "failed attempts happened before the give-up, so a leftover counter would be above zero",
                );
                await ctl("start_app");
                await waitForBroker();

                const mark = events.length;
                await adapter.connect();
                // Drift after the new connect: the checked queue is gone, the next reconnect's setup fails with a 404.
                await admin((ch) => ch.deleteQueue(queue));
                await dropConnections();
                await waitFor(() => events.slice(mark).some((e) => e.type === "setup-failed"));

                const first = events.slice(mark).find((e) => e.type === "setup-failed");
                assert.ok(first?.type === "setup-failed");
                assert.equal(first.initial, false);
                assert.equal(first.attempt, 1, "the first setup failure of the new connect() is attempt 1");
            } finally {
                await ctl("start_app").catch(() => undefined);
                await waitForBroker();
                await adapter.disconnect().catch(() => undefined);
                await admin(async (ch) => {
                    await ch.deleteQueue(queue);
                    await ch.deleteExchange(exchange);
                }).catch(() => undefined);
            }
        });
    });
});

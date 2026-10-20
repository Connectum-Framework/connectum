/**
 * Publish retry, publish drain and reconnect delays against a live broker.
 *
 * Each expectation comes from the documented contract, not from the adapter's
 * own helpers:
 * - the AMQP reliability guide: the delay formula
 *   `base = min(maxDelay / (1 + jitter), initialDelay × factor^(n − 1))`,
 *   `delay = round(uniform(base × (1 − jitter), base × (1 + jitter)))`;
 *   `publishRetry` defaults (5 retries), `retryOnTimeout`, the stable
 *   `x-event-id` / `messageId` across attempts;
 * - the events guide: `drainPublishTimeout` of `undefined`, `0` or a negative
 *   value disables the publish drain, and tracking a publish adds no
 *   unhandled rejection of its own;
 * - RabbitMQ publisher confirms: a publish whose confirm is lost is retried
 *   and reaches the queue again (at-least-once).
 *
 * Gated behind RUN_RECOVERY_TESTS=1 like the other broker-control suites: the
 * scenarios stop the broker app, pause the container and cut a proxied
 * connection mid-publish.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { StringValueSchema } from "@bufbuild/protobuf/wkt";
import { createEventBus, type EventAdapter } from "@connectum/events";
import { type Channel, type ConsumeMessage, connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter, computeRecoveryDelay } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpPublishTimeoutError, AmqpUnroutableError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent, AmqpPublishRetryOptions, AmqpRecoveryOptions } from "../../src/types.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";

const execFileAsync = promisify(execFile);

const RUN = process.env.RUN_RECOVERY_TESTS === "1";

/** Nothing listens on port 1 of the loopback: every connection attempt is refused at once. */
const UNREACHABLE_URL = "amqp://guest:guest@127.0.0.1:1";

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

/** Settle `promise` or fail after `ms`, so a hang becomes a readable assertion failure instead of a stuck run. */
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

/**
 * The documented reconnect / retry delay bounds for attempt `n`:
 * the capped exponential base and its symmetric jitter window.
 */
function documentedDelayWindow(params: { initialDelay: number; maxDelay: number; factor: number; jitter: number }, n: number): { min: number; max: number } {
    const base = Math.min(params.maxDelay / (1 + params.jitter), params.initialDelay * params.factor ** (n - 1));
    return { min: Math.round(base * (1 - params.jitter)), max: Math.round(base * (1 + params.jitter)) };
}

/** Counts `unhandledRejection` events for as long as it is installed. */
function trackUnhandledRejections(): { count(): number; dispose(): void } {
    let seen = 0;
    const listener = (): void => {
        seen += 1;
    };
    process.on("unhandledRejection", listener);
    return {
        count: () => seen,
        dispose: () => {
            process.off("unhandledRejection", listener);
        },
    };
}

/** A message for `bus.publish`; its routing key is the schema's full name, `google.protobuf.StringValue`. */
function message(value: string) {
    return create(StringValueSchema, { value });
}

const AMQP_BASIC_CLASS = 60;
const AMQP_BASIC_PUBLISH_METHOD = 40;
const AMQP_PROTOCOL_HEADER_LENGTH = 8;
const AMQP_FRAME_HEADER_LENGTH = 7;
const AMQP_METHOD_FRAME = 1;

interface MutingProxy {
    readonly port: number;
    /**
     * Arm the proxy: the next `basic.publish` a client sends is forwarded to the
     * broker unchanged, and from that moment the broker's replies on that
     * connection (the publisher confirm included) are discarded. Resolves once
     * that publish went through.
     */
    muteAfterNextPublish(): Promise<void>;
    /** Destroy the connection that was muted: the client sees the link drop with its confirm still outstanding. */
    severMuted(): void;
    close(): Promise<void>;
}

/** A TCP proxy that can swallow the broker's reply to one chosen publish and then cut that connection. */
async function startMutingProxy(target: { host: string; port: number }): Promise<MutingProxy> {
    let armed = false;
    let resolveMuted: () => void = () => undefined;
    const sockets = new Set<net.Socket>();
    let mutedPair: { client: net.Socket; upstream: net.Socket } | null = null;

    const server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        let muted = false;
        let clientBytes: Buffer = Buffer.alloc(0);
        let headerSkipped = false;

        const watch = (chunk: Buffer): void => {
            clientBytes = Buffer.concat([clientBytes, chunk]);
            if (!headerSkipped) {
                if (clientBytes.length < AMQP_PROTOCOL_HEADER_LENGTH) {
                    return;
                }
                clientBytes = clientBytes.subarray(AMQP_PROTOCOL_HEADER_LENGTH);
                headerSkipped = true;
            }
            while (clientBytes.length >= AMQP_FRAME_HEADER_LENGTH) {
                const size = clientBytes.readUInt32BE(3);
                const total = AMQP_FRAME_HEADER_LENGTH + size + 1;
                if (clientBytes.length < total) {
                    return;
                }
                const isMethod = clientBytes[0] === AMQP_METHOD_FRAME && size >= 4;
                if (armed && isMethod && clientBytes.readUInt16BE(7) === AMQP_BASIC_CLASS && clientBytes.readUInt16BE(9) === AMQP_BASIC_PUBLISH_METHOD) {
                    armed = false;
                    muted = true;
                    mutedPair = { client, upstream };
                }
                clientBytes = clientBytes.subarray(total);
            }
        };

        client.on("data", (chunk: Buffer) => {
            watch(chunk);
            upstream.write(chunk);
            if (muted && mutedPair?.client === client) {
                resolveMuted();
            }
        });
        upstream.on("data", (chunk: Buffer) => {
            if (!muted) {
                client.write(chunk);
            }
        });
        const closeBoth = (): void => {
            client.destroy();
            upstream.destroy();
            sockets.delete(client);
            sockets.delete(upstream);
        };
        client.on("close", closeBoth);
        upstream.on("close", closeBoth);
        client.on("error", () => undefined);
        upstream.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    return {
        port,
        muteAfterNextPublish() {
            armed = true;
            return new Promise<void>((resolve) => {
                resolveMuted = resolve;
            });
        },
        severMuted() {
            mutedPair?.client.destroy();
            mutedPair?.upstream.destroy();
        },
        async close() {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

describe("AMQP publish retry, publish drain and reconnect delays (testcontainers)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;

    /** Bring the broker app back and wait until it accepts AMQP connections; the container is shared by every test here. */
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

    async function stopBrokerApp(): Promise<void> {
        const stop = await container.exec(["rabbitmqctl", "stop_app"]);
        assert.equal(stop.exitCode, 0, `stop_app failed (${stop.exitCode}): ${stop.output}`);
    }

    before(async () => {
        container = await new GenericContainer(RABBITMQ_IMAGE).withExposedPorts(5672).start();
        url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
    });

    after(async () => {
        await container?.stop();
    });

    describe("publish retry delays", () => {
        /**
         * Connect with a recovery cycle parked far in the future (the wrapper stays
         * alive, so publish keeps retrying instead of giving up), stop the broker
         * app and wait for the adapter to see the drop.
         */
        async function connectedAdapterWithBrokerDown(params: {
            exchange: string;
            recovery: AmqpRecoveryOptions;
            publishRetry: AmqpPublishRetryOptions | true;
        }): Promise<ReturnType<typeof AmqpAdapter>> {
            let disconnected = false;
            const adapter = AmqpAdapter({
                url,
                exchange: params.exchange,
                recovery: params.recovery,
                publishRetry: params.publishRetry,
                lifecycle: {
                    onLifecycle: (event: AmqpLifecycleEvent) => {
                        if (event.type === "disconnected") {
                            disconnected = true;
                        }
                    },
                },
            });
            await adapter.connect();
            await stopBrokerApp();
            await waitFor(() => disconnected);
            return adapter;
        }

        it("publishRetry without maxRetries retries exactly 5 times; with jitter 0 each delay is min(maxDelay, initialDelay × 2^(n − 1))", { timeout: 60_000 }, async () => {
            const retries: Array<{ attempt: number; delay: number }> = [];
            const adapter = await connectedAdapterWithBrokerDown({
                exchange: "gaps.retry.default",
                recovery: { initialDelay: 30_000, maxDelay: 60_000 },
                publishRetry: { initialDelay: 20, maxDelay: 100, jitter: 0, onRetry: (info) => retries.push({ attempt: info.attempt, delay: info.delay }) },
            });
            try {
                await assert.rejects(
                    () => adapter.publish("gaps.retry.default.evt", new Uint8Array([1])),
                    (err: unknown) => err instanceof AmqpConnectionError,
                );
                assert.deepEqual(
                    retries,
                    [
                        { attempt: 1, delay: 20 },
                        { attempt: 2, delay: 40 },
                        { attempt: 3, delay: 80 },
                        { attempt: 4, delay: 100 },
                        { attempt: 5, delay: 100 },
                    ],
                    "five retries after the first attempt; the delay doubles from initialDelay and stops at maxDelay",
                );
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("publishRetry: true makes 5 retries on the default 100 ms doubling schedule (not fewer, not more)", { timeout: 60_000 }, async () => {
            const adapter = await connectedAdapterWithBrokerDown({
                exchange: "gaps.retry.true",
                recovery: { initialDelay: 30_000, maxDelay: 60_000 },
                publishRetry: true,
            });
            try {
                const startedAt = Date.now();
                await assert.rejects(
                    () => adapter.publish("gaps.retry.true.evt", new Uint8Array([1])),
                    (err: unknown) => err instanceof AmqpConnectionError,
                );
                const elapsed = Date.now() - startedAt;
                // Five retries wait 100, 200, 400, 800 and 1600 ms, each within ±20% jitter
                // (2480..3720 ms in total). A sixth retry would add 3200 ms ± 20% and push
                // the minimum to 5040 ms; a budget of only four retries would finish within 1800 ms.
                const fiveRetries = [100, 200, 400, 800, 1600].map((_, i) => documentedDelayWindow({ initialDelay: 100, maxDelay: 30_000, factor: 2, jitter: 0.2 }, i + 1));
                const minimum = fiveRetries.reduce((sum, w) => sum + w.min, 0);
                const maximum = fiveRetries.reduce((sum, w) => sum + w.max, 0);
                assert.ok(elapsed >= minimum, `elapsed ${elapsed}ms is below the five-retry minimum ${minimum}ms: fewer than 5 retries ran`);
                assert.ok(elapsed < 5_000, `elapsed ${elapsed}ms exceeds the five-retry budget (maximum ${maximum}ms): more than 5 retries ran`);
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("publish retry delays follow publishRetry, not a recovery.backoff hook (backoff returning 45 s does not leak into onRetry)", { timeout: 60_000 }, async () => {
            const retries: number[] = [];
            const adapter = await connectedAdapterWithBrokerDown({
                exchange: "gaps.retry.hook",
                recovery: { backoff: () => 45_000 },
                publishRetry: { initialDelay: 100, maxDelay: 200, jitter: 0, maxRetries: 3, onRetry: (info) => retries.push(info.delay) },
            });
            try {
                const startedAt = Date.now();
                await assert.rejects(
                    () => adapter.publish("gaps.retry.hook.evt", new Uint8Array([1])),
                    (err: unknown) => err instanceof AmqpConnectionError,
                );
                assert.deepEqual(retries, [100, 200, 200], "the delays come from publishRetry's own knobs");
                assert.ok(Date.now() - startedAt < 10_000, "the 45 s recovery hook delay must not stretch the publish retries");
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });

    describe("retryOnTimeout", () => {
        it("retryOnTimeout: true retries AmqpPublishTimeoutError and the publish succeeds once the broker answers again", { timeout: 60_000 }, async () => {
            const retries: Array<{ attempt: number; error: Error }> = [];
            const id = container.getId();
            let unpaused: Promise<unknown> | null = null;
            const adapter = AmqpAdapter({
                url,
                exchange: "gaps.timeout.retry",
                recovery: false,
                publishTimeoutMs: 300,
                publishRetry: {
                    initialDelay: 50,
                    maxDelay: 50,
                    jitter: 0,
                    maxRetries: 30,
                    retryOnTimeout: true,
                    onRetry: (info) => {
                        retries.push({ attempt: info.attempt, error: info.error });
                        // The first timeout is observed: let the broker answer the next attempt.
                        unpaused ??= execFileAsync("docker", ["unpause", id]);
                    },
                },
            });
            await adapter.connect();
            try {
                await execFileAsync("docker", ["pause", id]);
                await settleWithin(adapter.publish("gaps.timeout.retry.evt", new Uint8Array([1])), 30_000);
                assert.ok(retries.length >= 1, "the timed-out attempt was retried");
                assert.ok(retries[0]?.error instanceof AmqpPublishTimeoutError, "the retry was caused by the publish timeout");
                assert.equal(retries[0]?.attempt, 1);
            } finally {
                await execFileAsync("docker", ["unpause", id]).catch(() => undefined);
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("without retryOnTimeout a publish timeout is not retried, even with publishRetry enabled", { timeout: 60_000 }, async () => {
            const retries: number[] = [];
            const id = container.getId();
            const adapter = AmqpAdapter({
                url,
                exchange: "gaps.timeout.noretry",
                recovery: false,
                publishTimeoutMs: 300,
                publishRetry: { initialDelay: 20, maxDelay: 20, jitter: 0, maxRetries: 5, onRetry: (info) => retries.push(info.attempt) },
            });
            await adapter.connect();
            try {
                await execFileAsync("docker", ["pause", id]);
                await assert.rejects(
                    () => adapter.publish("gaps.timeout.noretry.evt", new Uint8Array([1])),
                    (err: unknown) => err instanceof AmqpPublishTimeoutError,
                );
                assert.deepEqual(retries, [], "AmqpPublishTimeoutError is outside the default retry boundary");
            } finally {
                await execFileAsync("docker", ["unpause", id]).catch(() => undefined);
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });

    describe("EventBus publish drain with a publish waiting in retry backoff", () => {
        interface StopOutcome {
            /** Milliseconds from `bus.stop()` to the adapter's `disconnect()` call. */
            readonly msUntilDisconnect: number;
            /** Whether the publish was still pending when `disconnect()` was called. */
            readonly publishPendingAtDisconnect: boolean;
            readonly publishError: unknown;
            readonly msUntilPublishSettled: number;
            readonly unhandledRejections: number;
        }

        /**
         * A bus publish sits in a 5 s retry backoff (broker app down, recovery parked)
         * when `bus.stop()` runs with the given `drainPublishTimeout`.
         */
        async function stopWhilePublishIsInBackoff(drainPublishTimeout: number): Promise<StopOutcome> {
            const unhandled = trackUnhandledRejections();
            let disconnected = false;
            let retryScheduled = false;
            const real = AmqpAdapter({
                url,
                exchange: "gaps.drain",
                recovery: { initialDelay: 30_000, maxDelay: 60_000 },
                publishRetry: { initialDelay: 5_000, maxDelay: 5_000, jitter: 0, maxRetries: 5, onRetry: () => (retryScheduled = true) },
                lifecycle: {
                    onLifecycle: (event: AmqpLifecycleEvent) => {
                        if (event.type === "disconnected") {
                            disconnected = true;
                        }
                    },
                },
            });
            let publishSettled = false;
            let publishSettledAt = 0;
            let publishError: unknown;
            let disconnectCalledAt = 0;
            let publishPendingAtDisconnect = false;
            const adapter: EventAdapter = {
                ...real,
                async disconnect() {
                    disconnectCalledAt = Date.now();
                    publishPendingAtDisconnect = !publishSettled;
                    await real.disconnect();
                },
            };
            const bus = createEventBus({ adapter, drainPublishTimeout });
            await bus.start();
            try {
                await stopBrokerApp();
                await waitFor(() => disconnected);

                // The caller handles its own rejection; whatever else surfaces is the bus's.
                const publishing = bus.publish(StringValueSchema, message("stuck")).then(
                    () => {
                        publishSettled = true;
                        publishSettledAt = Date.now();
                    },
                    (err: unknown) => {
                        publishSettled = true;
                        publishSettledAt = Date.now();
                        publishError = err;
                    },
                );
                await waitFor(() => retryScheduled);

                const stopStartedAt = Date.now();
                await settleWithin(bus.stop(), 20_000);
                await settleWithin(publishing, 20_000);
                // unhandledRejection is emitted after the microtask queue drains; one timer turn is enough.
                await sleep(100);
                return {
                    msUntilDisconnect: disconnectCalledAt - stopStartedAt,
                    publishPendingAtDisconnect,
                    publishError,
                    msUntilPublishSettled: publishSettledAt - stopStartedAt,
                    unhandledRejections: unhandled.count(),
                };
            } finally {
                unhandled.dispose();
                await bus.stop().catch(() => undefined);
                await real.disconnect().catch(() => undefined);
                await restoreBrokerApp();
            }
        }

        it("drainPublishTimeout makes stop() wait for the budget, then disconnect() aborts the publish stuck in backoff", { timeout: 90_000 }, async () => {
            const outcome = await stopWhilePublishIsInBackoff(800);

            assert.ok(outcome.msUntilDisconnect >= 700, `stop() must hold the adapter connected for the drain budget (disconnect came after ${outcome.msUntilDisconnect}ms of 800ms)`);
            assert.equal(outcome.publishPendingAtDisconnect, true, "the publish is still stuck in backoff when the budget runs out");
            assert.ok(outcome.publishError instanceof AmqpConnectionError, "disconnect() ends the backoff with the last typed connection error");
            assert.ok(outcome.msUntilPublishSettled < 4_000, `the publish must be aborted by disconnect(), not wait out the 5000ms backoff (it settled ${outcome.msUntilPublishSettled}ms after stop() began)`);
        });

        it("a negative drainPublishTimeout disables the publish drain: stop() disconnects at once", { timeout: 90_000 }, async () => {
            const outcome = await stopWhilePublishIsInBackoff(-1);

            assert.ok(outcome.msUntilDisconnect < 400, `a negative budget must not make stop() wait (disconnect came after ${outcome.msUntilDisconnect}ms)`);
            assert.equal(outcome.publishPendingAtDisconnect, true, "nothing waited for the publish");
            assert.ok(outcome.publishError instanceof AmqpConnectionError, "the publish still ends with the typed connection error");
        });

        it("a publish rejected after stop() begins, with the caller's promise handled, adds no unhandled rejection", { timeout: 90_000 }, async () => {
            const outcome = await stopWhilePublishIsInBackoff(300);

            assert.ok(outcome.publishError instanceof AmqpConnectionError, "the publish did reject after stop() started");
            assert.equal(outcome.unhandledRejections, 0, "tracking the publish for the drain must not leave an unhandled rejection of its own");
        });

        it("publishes that already settled (confirmed or rejected) are no longer waited for by stop()", { timeout: 60_000 }, async () => {
            const real = AmqpAdapter({ url, exchange: "gaps.drain.settled", publisherOptions: { mandatory: true } });
            const bus = createEventBus({ adapter: real, drainPublishTimeout: 4_000 });
            await bus.start();
            const probe = await connect(url);
            const probeChannel: Channel = await probe.createChannel();
            try {
                // A confirmed publish: bind a queue so the mandatory message is routable.
                await probeChannel.assertQueue("gaps.drain.settled.q", { exclusive: true });
                await probeChannel.bindQueue("gaps.drain.settled.q", "gaps.drain.settled", "google.protobuf.StringValue");
                await bus.publish(StringValueSchema, message("confirmed"));
                // A rejected publish: remove the binding so the mandatory message is returned.
                await probeChannel.unbindQueue("gaps.drain.settled.q", "gaps.drain.settled", "google.protobuf.StringValue");
                await assert.rejects(
                    () => bus.publish(StringValueSchema, message("unroutable")),
                    (err: unknown) => err instanceof AmqpUnroutableError,
                );

                const startedAt = Date.now();
                await bus.stop();
                const elapsed = Date.now() - startedAt;
                assert.ok(elapsed < 2_000, `stop() waited ${elapsed}ms although every publish had settled (drain budget 4000ms)`);
            } finally {
                await probe.close().catch(() => undefined);
                await bus.stop().catch(() => undefined);
            }
        });
    });

    describe("reconnect delays reported by amqplib", () => {
        it("steady state: every reconnecting delay stays within maxDelay and inside the documented jitter window", { timeout: 60_000 }, async () => {
            const recovery = { initialDelay: 100, maxDelay: 150, maxRetries: 4 };
            const reconnecting: Array<{ attempt: number; delay: number }> = [];
            let failed = false;
            const adapter = AmqpAdapter({
                url,
                exchange: "gaps.delay.steady",
                recovery,
                lifecycle: {
                    onLifecycle: (event: AmqpLifecycleEvent) => {
                        if (event.type === "reconnecting") {
                            reconnecting.push({ attempt: event.attempt, delay: event.delay });
                        } else if (event.type === "reconnect-failed") {
                            failed = true;
                        }
                    },
                },
            });
            await adapter.connect();
            try {
                await stopBrokerApp();
                await waitFor(() => failed);
                assert.ok(reconnecting.length >= 3, `the schedule must reach saturation (saw ${reconnecting.length} attempts)`);
                for (const { attempt, delay } of reconnecting) {
                    const window = documentedDelayWindow({ ...recovery, factor: 2, jitter: 0.2 }, attempt);
                    assert.ok(delay <= 150, `attempt ${attempt}: delay ${delay}ms exceeds maxDelay 150ms`);
                    assert.ok(delay >= window.min && delay <= window.max, `attempt ${attempt}: delay ${delay}ms outside the documented window ${window.min}..${window.max}ms`);
                }
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        // The documented default jitter is 0.2. With jitter 0 every saturated attempt would report the
        // same delay, so repetition across many saturated attempts shows the jitter was lost; with
        // the documented jitter the chance that seven draws from about fifty values are all equal is
        // negligible.
        it("with the default jitter the saturated delays vary inside the documented window instead of repeating one value", { timeout: 60_000 }, async () => {
            const recovery = { initialDelay: 100, maxDelay: 150, maxRetries: 8 };
            const reconnecting: Array<{ attempt: number; delay: number }> = [];
            let failed = false;
            const adapter = AmqpAdapter({
                url,
                exchange: "gaps.delay.jitter",
                recovery,
                lifecycle: {
                    onLifecycle: (event: AmqpLifecycleEvent) => {
                        if (event.type === "reconnecting") {
                            reconnecting.push({ attempt: event.attempt, delay: event.delay });
                        } else if (event.type === "reconnect-failed") {
                            failed = true;
                        }
                    },
                },
            });
            await adapter.connect();
            try {
                await stopBrokerApp();
                await waitFor(() => failed);
                // From attempt 2 the base is saturated at maxDelay / (1 + jitter) = 125 ms.
                const saturated = reconnecting.filter((r) => r.attempt >= 2);
                assert.ok(saturated.length >= 6, `enough saturated attempts to tell jitter from none (saw ${saturated.length})`);
                for (const { attempt, delay } of saturated) {
                    const window = documentedDelayWindow({ ...recovery, factor: 2, jitter: 0.2 }, attempt);
                    assert.ok(delay >= window.min && delay <= window.max, `attempt ${attempt}: delay ${delay}ms outside the documented window ${window.min}..${window.max}ms`);
                }
                assert.ok(new Set(saturated.map((r) => r.delay)).size >= 2, `the saturated delays repeat one value, so no jitter was applied: ${JSON.stringify(saturated.map((r) => r.delay))}`);
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });

        it("initial connect window: every reconnecting delay stays within maxDelay and inside the documented jitter window", { timeout: 60_000 }, async () => {
            const recovery = { initialDelay: 100, maxDelay: 150, initialConnectMaxRetries: 4 };
            const reconnecting: Array<{ attempt: number; delay: number }> = [];
            const adapter = AmqpAdapter({
                url: UNREACHABLE_URL,
                exchange: "gaps.delay.initial",
                recovery,
                lifecycle: {
                    onLifecycle: (event: AmqpLifecycleEvent) => {
                        if (event.type === "reconnecting") {
                            reconnecting.push({ attempt: event.attempt, delay: event.delay });
                        }
                    },
                },
            });
            await assert.rejects(() => adapter.connect(), AmqpConnectionError);
            assert.ok(reconnecting.length >= 3, `the schedule must reach saturation (saw ${reconnecting.length} attempts)`);
            for (const { attempt, delay } of reconnecting) {
                const window = documentedDelayWindow({ initialDelay: 100, maxDelay: 150, factor: 2, jitter: 0.2 }, attempt);
                assert.ok(delay <= 150, `attempt ${attempt}: delay ${delay}ms exceeds maxDelay 150ms`);
                assert.ok(delay >= window.min && delay <= window.max, `attempt ${attempt}: delay ${delay}ms outside the documented window ${window.min}..${window.max}ms`);
            }
        });

        it("with jitter 0 the delay amqplib reports equals the documented formula and the adapter's computeRecoveryDelay", { timeout: 60_000 }, async () => {
            const recovery = { initialDelay: 50, maxDelay: 300, factor: 3, jitter: 0, maxRetries: 5 };
            const reconnecting: Array<{ attempt: number; delay: number }> = [];
            let failed = false;
            const adapter = AmqpAdapter({
                url,
                exchange: "gaps.delay.exact",
                recovery,
                lifecycle: {
                    onLifecycle: (event: AmqpLifecycleEvent) => {
                        if (event.type === "reconnecting") {
                            reconnecting.push({ attempt: event.attempt, delay: event.delay });
                        } else if (event.type === "reconnect-failed") {
                            failed = true;
                        }
                    },
                },
            });
            await adapter.connect();
            try {
                await stopBrokerApp();
                await waitFor(() => failed);
                assert.ok(reconnecting.length >= 4, `the schedule must pass saturation (saw ${reconnecting.length} attempts)`);
                for (const { attempt, delay } of reconnecting) {
                    const documented = Math.min(recovery.maxDelay, recovery.initialDelay * recovery.factor ** (attempt - 1));
                    assert.equal(delay, documented, `attempt ${attempt}: amqplib's delay must equal min(maxDelay, initialDelay × factor^(n − 1))`);
                    assert.equal(computeRecoveryDelay(recovery, attempt), delay, `attempt ${attempt}: the adapter's copy of the formula must agree with amqplib`);
                }
            } finally {
                await restoreBrokerApp();
                await adapter.disconnect().catch(() => undefined);
            }
        });
    });

    describe("a publish whose confirm is lost in flight", () => {
        it("both deliveries carry the same x-event-id and messageId", { timeout: 60_000 }, async () => {
            const proxy = await startMutingProxy({ host: container.getHost(), port: container.getMappedPort(5672) });
            const retries: number[] = [];
            const adapter = AmqpAdapter({
                url: `amqp://guest:guest@127.0.0.1:${proxy.port}`,
                exchange: "gaps.dup",
                exchangeType: "topic",
                recovery: { initialDelay: 50, maxDelay: 100 },
                publishRetry: { initialDelay: 50, maxDelay: 100, jitter: 0, maxRetries: 30, onRetry: (info) => retries.push(info.attempt) },
            });
            await adapter.connect();
            // A consumer that talks to the broker directly, so it sees every copy the broker queued.
            const consumerConnection = await connect(url);
            const consumerChannel = await consumerConnection.createChannel();
            const deliveries: ConsumeMessage[] = [];
            try {
                await consumerChannel.assertQueue("gaps.dup.q", { exclusive: true });
                await consumerChannel.bindQueue("gaps.dup.q", "gaps.dup", "gaps.dup.evt");
                await consumerChannel.consume("gaps.dup.q", (msg) => msg !== null && deliveries.push(msg), { noAck: true });

                const published = proxy.muteAfterNextPublish();
                const publishing = adapter.publish("gaps.dup.evt", new TextEncoder().encode("once"));
                await published;
                // The broker has the message once the direct consumer gets it; its confirm was swallowed.
                await waitFor(() => deliveries.length === 1);
                proxy.severMuted();

                await settleWithin(publishing, 30_000);
                await waitFor(() => deliveries.length === 2);

                assert.ok(retries.length >= 1, "the lost confirm made the publish retry");
                const [first, second] = deliveries as [ConsumeMessage, ConsumeMessage];
                const firstEventId = first.properties.headers?.["x-event-id"];
                assert.equal(typeof firstEventId, "string");
                assert.ok(String(firstEventId).length > 0);
                assert.equal(second.properties.headers?.["x-event-id"], firstEventId, "the duplicate carries the original x-event-id");
                assert.equal(typeof first.properties.messageId, "string");
                assert.equal(second.properties.messageId, first.properties.messageId, "the duplicate carries the original messageId");
                assert.equal(first.content.toString(), "once");
                assert.equal(second.content.toString(), "once");
            } finally {
                await consumerConnection.close().catch(() => undefined);
                await adapter.disconnect().catch(() => undefined);
                await proxy.close();
            }
        });
    });
});

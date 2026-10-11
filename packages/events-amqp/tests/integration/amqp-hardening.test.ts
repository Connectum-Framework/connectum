/**
 * Publish guard, connect()/disconnect() overlap and option validation,
 * observed on live brokers.
 *
 * Each scenario fails on a real broker for the old behavior: a publish that
 * slips through while connect() is still running, a connection that survives
 * a disconnect() between two connect() calls, a `publishTimeoutMs` that
 * rejects every publish, a `maxRetries` that ignores a negative budget, and a
 * publish after a connection loss that reports a closed channel instead of
 * the missing connection. The brokers under test come from
 * `AMQP_HARDENING_BROKER_IMAGES` (comma separated); the default is the image
 * the rest of the suite uses.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpPublishTimeoutError } from "../../src/errors.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";
const IMAGES = (process.env.AMQP_HARDENING_BROKER_IMAGES ?? RABBITMQ_IMAGE)
    .split(",")
    .map((image) => image.trim())
    .filter((image) => image !== "");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(50);
    }
}

function describeError(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const AMQP_CHANNEL_CLASS = 20;
const AMQP_CHANNEL_OPEN_METHOD = 10;
const AMQP_PROTOCOL_HEADER_LENGTH = 8;
const AMQP_FRAME_HEADER_LENGTH = 7;
const AMQP_METHOD_FRAME = 1;

interface GatedProxy {
    readonly port: number;
    /** Settles when the first proxied connection has sent its first `channel.open`, i.e. its setup has started. */
    readonly setupStarted: Promise<void>;
    /** Lets the broker's replies reach the first connection again. */
    release(): void;
    close(): Promise<void>;
}

/**
 * A TCP proxy in front of the broker that freezes the broker-to-client
 * direction of the FIRST connection the moment that connection opens its
 * first channel. The client has finished the handshake by then, so its setup
 * hook is running and stays parked on the reply until `release()`; every later
 * connection passes through untouched. This makes "a connect() whose setup
 * finishes after a newer connect() took over" a fixed order of events instead
 * of a timing race.
 */
async function startGatedProxy(target: { host: string; port: number }): Promise<GatedProxy> {
    let held = false;
    let released = false;
    let resolveSetupStarted: () => void = () => undefined;
    const setupStarted = new Promise<void>((resolve) => {
        resolveSetupStarted = resolve;
    });
    const sockets = new Set<net.Socket>();
    let connections = 0;
    let flush: () => void = () => undefined;

    const server = net.createServer((client) => {
        const gated = connections === 0;
        connections += 1;
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        const buffered: Buffer[] = [];
        let clientBytes: Buffer = Buffer.alloc(0);
        let headerSkipped = false;

        const watchChannelOpen = (chunk: Buffer): void => {
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
                if (isMethod && clientBytes.readUInt16BE(7) === AMQP_CHANNEL_CLASS && clientBytes.readUInt16BE(9) === AMQP_CHANNEL_OPEN_METHOD && !released) {
                    held = true;
                    resolveSetupStarted();
                }
                clientBytes = clientBytes.subarray(total);
            }
        };

        client.on("data", (chunk: Buffer) => {
            if (gated && !released && !held) {
                watchChannelOpen(chunk);
            }
            upstream.write(chunk);
        });
        upstream.on("data", (chunk: Buffer) => {
            if (gated && held) {
                buffered.push(chunk);
                return;
            }
            client.write(chunk);
        });
        if (gated) {
            flush = () => {
                held = false;
                released = true;
                for (const chunk of buffered.splice(0)) {
                    client.write(chunk);
                }
            };
        }
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.on("error", () => undefined);
        upstream.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("gated proxy: no TCP address");
    }
    return {
        port: address.port,
        setupStarted,
        release: () => flush(),
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

for (const image of IMAGES) {
    describe(`AMQP publish guard and lifecycle hardening on ${image} (testcontainers)`, { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
        let container: StartedTestContainer;
        let url: string;

        before(async () => {
            // The broker log, not the port, says the broker is ready: an exec
            // before the server wrote its cookie file crashes it.
            container = await new GenericContainer(image)
                .withExposedPorts(5672)
                .withWaitStrategy(Wait.forLogMessage("Server startup complete"))
                .start();
            url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
        });

        after(async () => {
            await container?.stop();
        });

        async function ctl(...args: string[]): Promise<string> {
            const { output } = await container.exec(["rabbitmqctl", "-q", ...args], { user: "rabbitmq" });
            return output;
        }

        /** Number of broker connections whose client properties carry `name`. */
        async function connectionsNamed(name: string): Promise<number> {
            const output = await ctl("list_connections", "client_properties");
            return output.split("\n").filter((line) => line.includes(name)).length;
        }

        async function connectionsNamedSettled(name: string, expected: number): Promise<number> {
            for (let i = 0; i < 40; i += 1) {
                if ((await connectionsNamed(name)) === expected) {
                    break;
                }
                await sleep(150);
            }
            return connectionsNamed(name);
        }

        for (const mode of [
            { label: "recovery: false", recovery: false as const, lifecycle: false },
            { label: "recovery with lifecycle (startup probe)", recovery: true as const, lifecycle: true },
            { label: "recovery with a bounded initial connect", recovery: { initialConnectMaxRetries: 2 }, lifecycle: false },
        ]) {
            it(`publish() is refused with the typed not-connected error for the whole connect() (${mode.label})`, async () => {
                const exchange = `hardening.guard.${Math.random().toString(36).slice(2, 8)}`;
                const adapter = AmqpAdapter({
                    url,
                    exchange,
                    recovery: mode.recovery,
                    ...(mode.lifecycle ? { lifecycle: { onLifecycle: () => undefined } } : {}),
                    topology: { queues: [{ name: `${exchange}.q1` }, { name: `${exchange}.q2` }] },
                });
                let connectSettled = false;
                const connecting = adapter.connect().finally(() => {
                    connectSettled = true;
                });
                const outcomes: string[] = [];
                const pending: Promise<void>[] = [];
                while (!connectSettled) {
                    // Every publish is issued while connect() has not settled.
                    pending.push(
                        adapter.publish("hardening.guard.evt", new Uint8Array([1])).then(
                            () => {
                                outcomes.push("resolved");
                            },
                            (err: unknown) => {
                                outcomes.push(err instanceof AmqpConnectionError && /not connected/.test(err.message) ? "not-connected" : describeError(err));
                            },
                        ),
                    );
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }
                await connecting;
                await Promise.all(pending);
                try {
                    const leaked = outcomes.filter((outcome) => outcome !== "not-connected");
                    assert.deepEqual(
                        leaked,
                        [],
                        `${leaked.length} of ${outcomes.length} publishes issued before connect() settled were not refused as not-connected: ${JSON.stringify([...new Set(leaked)])}`,
                    );
                    await adapter.publish("hardening.guard.evt", new Uint8Array([1]));
                } finally {
                    await adapter.disconnect();
                    await ctl("delete_queue", `${exchange}.q1`);
                    await ctl("delete_queue", `${exchange}.q2`);
                }
            });
        }

        for (const recovery of [false, true] as const) {
            it(`a connect() superseded by disconnect() leaves no connection behind (recovery: ${recovery})`, async () => {
                const name = `hardening-overlap-${recovery}-${Math.random().toString(36).slice(2, 8)}`;
                const events: string[] = [];
                const adapter = AmqpAdapter({ url, exchange: "hardening.overlap", recovery, lifecycle: { onLifecycle: (event: AmqpLifecycleEvent) => events.push(event.type) } });

                const first = adapter.connect({ serviceName: name }).then(
                    () => "resolved",
                    (err: unknown) => describeError(err),
                );
                await adapter.disconnect();
                const second = adapter.connect({ serviceName: name }).then(
                    () => "resolved",
                    (err: unknown) => describeError(err),
                );
                const firstOutcome = await first;
                const secondOutcome = await second;
                const liveConnections = await connectionsNamedSettled(name, 1);

                assert.equal(liveConnections, 1, "exactly the second connect() keeps a connection");
                assert.match(firstOutcome, /AmqpConnectionError: Adapter closed (while connect\(\) was in progress|during the initial connect phase)/, "the superseded connect() must not report success");
                assert.equal(secondOutcome, "resolved");
                assert.deepEqual(events, ["connected"], "one connected event: the superseded connect() reports nothing");
                await adapter.publish("hardening.overlap.evt", new Uint8Array([1]));

                await adapter.disconnect();
                assert.equal(await connectionsNamedSettled(name, 0), 0, "disconnect() closes the only connection");
            });
        }

        for (const mode of [
            { label: "recovery: false", recovery: false as const, lifecycle: false },
            { label: "recovery", recovery: true as const, lifecycle: false },
            { label: "recovery with lifecycle (startup probe)", recovery: true as const, lifecycle: true },
        ]) {
            it(`a superseded connect() whose setup finishes late does not take over the publish channel (${mode.label})`, async () => {
                const name = `hardening-late-setup-${Math.random().toString(36).slice(2, 8)}`;
                const proxy = await startGatedProxy({ host: container.getHost(), port: container.getMappedPort(5672) });
                const adapter = AmqpAdapter({
                    url: `amqp://guest:guest@127.0.0.1:${proxy.port}`,
                    exchange: "hardening.late-setup",
                    recovery: mode.recovery,
                    ...(mode.lifecycle ? { lifecycle: { onLifecycle: () => undefined } } : {}),
                });
                try {
                    const first = adapter.connect({ serviceName: name }).then(
                        () => "resolved",
                        (err: unknown) => describeError(err),
                    );
                    await proxy.setupStarted;
                    await adapter.disconnect();
                    await adapter.connect({ serviceName: name });

                    // The first connect() resumes only now, with its setup finishing after the second one is live.
                    proxy.release();
                    const firstOutcome = await first;

                    assert.match(firstOutcome, /AmqpConnectionError: Adapter closed while connect\(\) was in progress/, "the superseded connect() must not report success");
                    await adapter.publish("hardening.late-setup.evt", new Uint8Array([1]));
                } finally {
                    await adapter.disconnect();
                    await proxy.close();
                }
            });
        }

        it("a second connect() while the first is still running is refused and opens no second connection", async () => {
            const name = `hardening-concurrent-${Math.random().toString(36).slice(2, 8)}`;
            const adapter = AmqpAdapter({ url, exchange: "hardening.concurrent", recovery: false });
            const first = adapter.connect({ serviceName: name });
            const secondOutcome = await adapter.connect({ serviceName: name }).then(
                () => "resolved",
                (err: unknown) => describeError(err),
            );
            await first;
            const liveConnections = await connectionsNamedSettled(name, 1);
            assert.equal(liveConnections, 1, "only one connection is open");
            assert.match(secondOutcome, /AmqpConnectionError: AmqpAdapter: (already connected|connect\(\) already in progress)/);
            await adapter.disconnect();
            assert.equal(await connectionsNamedSettled(name, 0), 0);
        });

        it("publish() after a connection loss reports the missing connection, not a closed channel", async () => {
            const events: string[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange: "hardening.loss",
                recovery: { initialDelay: 5_000, maxDelay: 5_000, jitter: 0 },
                lifecycle: { onLifecycle: (event: AmqpLifecycleEvent) => events.push(event.type) },
            });
            await adapter.connect();
            try {
                await adapter.publish("hardening.loss.evt", new Uint8Array([1]));
                await ctl("close_all_connections", "hardening-drop");
                await waitFor(() => events.includes("disconnected"), 5_000);
                const outcome = await adapter.publish("hardening.loss.evt", new Uint8Array([1])).then(
                    () => "resolved",
                    (err: unknown) => err,
                );
                assert.ok(outcome instanceof AmqpConnectionError, `expected AmqpConnectionError, got ${describeError(outcome)}`);
                assert.match(outcome.message, /not connected \(or recovery in progress\)/);
            } finally {
                await adapter.disconnect();
            }
        });

        for (const [label, value] of [
            ["NaN", Number.NaN],
            ["0", 0],
            ["-5", -5],
            ["Infinity", Number.POSITIVE_INFINITY],
            ["above the timer limit", 2 ** 31],
        ] as const) {
            it(`publishTimeoutMs ${label} does not turn healthy publishes into timeouts`, async () => {
                const adapter = AmqpAdapter({ url, exchange: "hardening.timeout", recovery: false, publishTimeoutMs: value });
                await adapter.connect();
                try {
                    const outcomes: string[] = [];
                    for (let i = 0; i < 20; i += 1) {
                        await adapter.publish("hardening.timeout.evt", new Uint8Array([1])).then(
                            () => outcomes.push("resolved"),
                            (err: unknown) => outcomes.push(err instanceof AmqpPublishTimeoutError ? "timeout" : describeError(err)),
                        );
                    }
                    assert.deepEqual(outcomes, Array(20).fill("resolved"));
                } finally {
                    await adapter.disconnect();
                }
            });
        }

        for (const [label, value] of [
            ["-Infinity", Number.NEGATIVE_INFINITY],
            ["-1", -1],
        ] as const) {
            it(`publishRetry.maxRetries ${label} means a single attempt`, async () => {
                let retries = 0;
                const events: string[] = [];
                const adapter = AmqpAdapter({
                    url,
                    exchange: "hardening.retry",
                    recovery: { initialDelay: 5_000, maxDelay: 5_000, jitter: 0 },
                    publishRetry: {
                        maxRetries: value,
                        initialDelay: 10,
                        maxDelay: 10,
                        jitter: 0,
                        onRetry: () => {
                            retries += 1;
                        },
                    },
                    lifecycle: { onLifecycle: (event: AmqpLifecycleEvent) => events.push(event.type) },
                });
                await adapter.connect();
                try {
                    await ctl("close_all_connections", "hardening-drop");
                    await waitFor(() => events.includes("disconnected"), 5_000);
                    const outcome = await adapter.publish("hardening.retry.evt", new Uint8Array([1])).then(
                        () => "resolved",
                        (err: unknown) => err,
                    );
                    assert.ok(outcome instanceof AmqpConnectionError, `expected AmqpConnectionError, got ${describeError(outcome)}`);
                    assert.equal(retries, 0, "a negative budget clamps to zero retries");
                } finally {
                    await adapter.disconnect();
                }
            });
        }

        it("recovery: false — a manual connect() after a broker close replays the subscription on a new private queue", async () => {
            const exchange = `hardening.norecovery.${Math.random().toString(36).slice(2, 8)}`;
            const events: string[] = [];
            const received: string[] = [];
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false, lifecycle: { onLifecycle: (event: AmqpLifecycleEvent) => events.push(event.type) } });
            await adapter.connect();
            try {
                await adapter.subscribe([`${exchange}.evt`], async (event) => {
                    received.push(new TextDecoder().decode(event.payload));
                });
                const privateQueues = async (): Promise<string[]> =>
                    (await ctl("list_queues", "name"))
                        .split("\n")
                        .map((line) => line.trim())
                        .filter((line) => line.startsWith(`${exchange}.sub-`));
                const before = await privateQueues();
                assert.equal(before.length, 1);

                await ctl("close_all_connections", "hardening-drop");
                await waitFor(() => events.includes("disconnected"), 5_000);
                assert.deepEqual(await privateQueues(), [], "the private queue dies with its connection");

                await adapter.connect();
                const after = await privateQueues();
                assert.equal(after.length, 1, "the replayed subscription declares a private queue again");
                assert.notEqual(after[0], before[0], "under a new name");

                await adapter.publish(`${exchange}.evt`, new TextEncoder().encode("again"));
                await waitFor(() => received.length === 1, 5_000);
                assert.deepEqual(received, ["again"]);
            } finally {
                await adapter.disconnect();
            }
        });
    });
}

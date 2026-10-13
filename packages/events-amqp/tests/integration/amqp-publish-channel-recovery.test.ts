/**
 * The publish channel after the broker closed only that channel.
 *
 * A publish to an exchange that does not exist makes RabbitMQ close the channel
 * (reply 404) while the connection stays up. The oracle is the AMQP 0-9-1 /
 * RabbitMQ behaviour: https://www.rabbitmq.com/docs/channels#error-handling and
 * https://www.rabbitmq.com/docs/publishers#unroutable. The ordering of the
 * adapter's channel opens is made deterministic by a TCP proxy that holds the
 * broker's reply to one chosen `channel.open`, instead of sleeping.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpUnroutableError } from "../../src/errors.ts";
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
        await sleep(25);
    }
}

const AMQP_CHANNEL_CLASS = 20;
const AMQP_CHANNEL_OPEN_METHOD = 10;
const AMQP_PROTOCOL_HEADER_LENGTH = 8;
const AMQP_FRAME_HEADER_LENGTH = 7;
const AMQP_METHOD_FRAME = 1;

interface CountingProxy {
    readonly port: number;
    /** `channel.open` frames the clients have sent through the proxy so far. */
    channelOpens(): number;
    /** Hold the broker's replies to every connection from the next `channel.open` on, until `release()`. */
    holdNextChannelOpen(): Promise<void>;
    release(): void;
    close(): Promise<void>;
}

/** A TCP proxy that counts client `channel.open` frames and can freeze the broker-to-client direction at one of them. */
async function startProxy(target: { host: string; port: number }): Promise<CountingProxy> {
    let opens = 0;
    let armed = false;
    let held = false;
    let resolveHeld: () => void = () => undefined;
    let heldSignal = Promise.resolve();
    const sockets = new Set<net.Socket>();
    const pending: Array<() => void> = [];

    const server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
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
                if (isMethod && clientBytes.readUInt16BE(7) === AMQP_CHANNEL_CLASS && clientBytes.readUInt16BE(9) === AMQP_CHANNEL_OPEN_METHOD) {
                    opens += 1;
                    if (armed) {
                        armed = false;
                        held = true;
                        resolveHeld();
                    }
                }
                clientBytes = clientBytes.subarray(total);
            }
        };

        client.on("data", (chunk: Buffer) => {
            watch(chunk);
            upstream.write(chunk);
        });
        upstream.on("data", (chunk: Buffer) => {
            if (held) {
                pending.push(() => client.write(chunk));
            } else {
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
        channelOpens: () => opens,
        holdNextChannelOpen() {
            armed = true;
            held = false;
            heldSignal = new Promise<void>((resolve) => {
                resolveHeld = resolve;
            });
            return heldSignal;
        },
        release() {
            held = false;
            armed = false;
            for (const flush of pending.splice(0)) {
                flush();
            }
        },
        async close() {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

describe("AMQP publish channel recovery after a channel-only close", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let brokerUrl: string;
    let proxy: CountingProxy;
    let url: string;

    before(async () => {
        container = await new GenericContainer(RABBITMQ_IMAGE).withExposedPorts(5672).start();
        brokerUrl = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
        proxy = await startProxy({ host: container.getHost(), port: container.getMappedPort(5672) });
        url = `amqp://guest:guest@127.0.0.1:${proxy.port}`;
    });

    after(async () => {
        await proxy?.close();
        await container?.stop();
    });

    /** Create an exchange from outside the adapter, as an operator or a deploy step would. */
    async function declareExchange(name: string): Promise<void> {
        const conn = await connect(brokerUrl);
        try {
            const ch = await conn.createChannel();
            await ch.assertExchange(name, "topic", { durable: false, autoDelete: false });
        } finally {
            await conn.close();
        }
    }

    function collect(): { events: AmqpLifecycleEvent[]; types: () => string[]; onLifecycle: (event: AmqpLifecycleEvent) => void } {
        const events: AmqpLifecycleEvent[] = [];
        return { events, types: () => events.map((e) => e.type), onLifecycle: (event) => events.push(event) };
    }

    async function expectBrokerRefusal(publish: Promise<void>, code: number): Promise<void> {
        await assert.rejects(publish, (err: unknown) => {
            assert.ok(err instanceof AmqpConnectionError, "surfaces as a connection-class error");
            assert.equal(((err as Error).cause as { code?: number } | undefined)?.code, code, "the broker reply is the cause");
            return true;
        });
    }

    it("a 404 on a missing exchange fails that publish only; once the exchange exists the next publish succeeds without a reconnect", { timeout: 60_000 }, async () => {
        const seen = collect();
        const exchange = "pcr.missing-then-created";
        const adapter = AmqpAdapter({ url, exchange, topologyMode: "skip", lifecycle: { onLifecycle: seen.onLifecycle } });
        await adapter.connect();
        try {
            await expectBrokerRefusal(adapter.publish("pcr.evt", new Uint8Array([1])), 404);
            await waitFor(() => seen.types().includes("publish-channel-lost"));
            const lost = seen.events.find((e) => e.type === "publish-channel-lost");
            assert.equal(((lost as { error: Error }).error as unknown as { code?: number }).code, 404, "the loss event carries the broker reply");

            await declareExchange(exchange);
            await adapter.publish("pcr.evt", new Uint8Array([2]));

            assert.deepEqual(
                seen.types(),
                ["connected", "publish-channel-lost", "publish-channel-restored"],
                "one loss, one restoration, and no connection-level event in between",
            );
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishers that start on the closed channel share one recreation: exactly one channel.open", { timeout: 60_000 }, async () => {
        const seen = collect();
        const exchange = "pcr.concurrent";
        const adapter = AmqpAdapter({ url, exchange, topologyMode: "skip", lifecycle: { onLifecycle: seen.onLifecycle } });
        await adapter.connect();
        try {
            await expectBrokerRefusal(adapter.publish("pcr.evt", new Uint8Array([1])), 404);
            await declareExchange(exchange);

            const opensBefore = proxy.channelOpens();
            const held = proxy.holdNextChannelOpen();
            const publishes = Array.from({ length: 5 }, (_, i) => adapter.publish("pcr.evt", new Uint8Array([i])));
            await held;
            proxy.release();
            await Promise.all(publishes);

            assert.equal(proxy.channelOpens() - opensBefore, 1, "five waiting publishes opened one channel");
            assert.equal(seen.types().filter((t) => t === "publish-channel-restored").length, 1);
        } finally {
            proxy.release();
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("disconnect() while the new channel is opening leaves no channel and no restoration", { timeout: 60_000 }, async () => {
        const seen = collect();
        const exchange = "pcr.disconnect-during";
        const adapter = AmqpAdapter({ url, exchange, topologyMode: "skip", lifecycle: { onLifecycle: seen.onLifecycle } });
        await adapter.connect();
        try {
            await expectBrokerRefusal(adapter.publish("pcr.evt", new Uint8Array([1])), 404);
            await declareExchange(exchange);

            const held = proxy.holdNextChannelOpen();
            const publish = adapter.publish("pcr.evt", new Uint8Array([2]));
            const outcome = publish.then(
                () => "published",
                (err: unknown) => (err instanceof AmqpConnectionError ? "connection-error" : `other: ${String(err)}`),
            );
            await held;
            const disconnecting = adapter.disconnect();
            proxy.release();
            await disconnecting;

            assert.equal(await outcome, "connection-error", "the publish that waited for the channel fails once the adapter is closed");
            assert.ok(!seen.types().includes("publish-channel-restored"), "a channel opened after disconnect() is not adopted");
            await assert.rejects(adapter.publish("pcr.evt", new Uint8Array([3])), AmqpConnectionError, "a closed adapter holds no publish channel");
        } finally {
            proxy.release();
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("publishRetry: the 404 is attempted once and never retried, and the next publish still succeeds on the new channel", { timeout: 60_000 }, async () => {
        const retries: number[] = [];
        const exchange = "pcr.retry-gate";
        const adapter = AmqpAdapter({
            url,
            exchange,
            topologyMode: "skip",
            publishRetry: { initialDelay: 200, maxDelay: 400, jitter: 0, maxRetries: 10, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            await expectBrokerRefusal(adapter.publish("pcr.evt", new Uint8Array([1])), 404);
            await declareExchange(exchange);
            await adapter.publish("pcr.evt", new Uint8Array([2]));
            assert.deepEqual(retries, [], "a deterministic channel close burns no retry budget, before or after the channel was recreated");
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a connection loss is not reported as a publish channel loss", { timeout: 60_000 }, async () => {
        const seen = collect();
        const adapter = AmqpAdapter({ url, exchange: "pcr.drop", recovery: { initialDelay: 100, maxDelay: 500 }, lifecycle: { onLifecycle: seen.onLifecycle } });
        await adapter.connect();
        try {
            const res = await container.exec(["rabbitmqctl", "close_all_connections", "test-drop"]);
            assert.equal(res.exitCode, 0);
            await waitFor(() => seen.types().filter((t) => t === "connected").length >= 2);

            assert.ok(seen.types().includes("disconnected"));
            assert.ok(!seen.types().includes("publish-channel-lost"), "connection recovery owns this case");
            await adapter.publish("pcr.evt", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("a mandatory publish on the recreated channel is still detected as unroutable", { timeout: 60_000 }, async () => {
        const exchange = "pcr.mandatory";
        const adapter = AmqpAdapter({ url, exchange, topologyMode: "skip", publisherOptions: { mandatory: true } });
        await adapter.connect();
        try {
            await expectBrokerRefusal(adapter.publish("pcr.evt", new Uint8Array([1])), 404);
            await declareExchange(exchange);
            // The exchange exists now but has no bound queue: the broker returns the message.
            await assert.rejects(adapter.publish("pcr.evt", new Uint8Array([2])), AmqpUnroutableError);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });
});

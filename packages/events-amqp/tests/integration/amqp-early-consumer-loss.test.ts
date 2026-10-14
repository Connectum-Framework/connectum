/**
 * A consumer the broker ends while `subscribe()` has not returned yet.
 *
 * The adapter must not drop that loss and must not report it before the
 * consumer setup has finished: it remembers the loss and reports
 * `consumer-lost` right after the setup returns, then restores the consumer
 * like any other loss. The oracle is the documented reliability contract
 * ("A loss during `subscribe()` is not lost") and RabbitMQ's consumer
 * cancellation notification: https://www.rabbitmq.com/docs/consumer-cancel
 *
 * The window is made deterministic without sleeping. A TCP proxy freezes the
 * broker-to-client direction from the client's `basic.consume` on, so the
 * `consume-ok` reply is held. The queue is then deleted from a separate,
 * direct connection once the broker shows the consumer registered; the
 * broker's `basic.cancel` is held behind the `consume-ok`. Releasing the proxy
 * writes both frames as one chunk, so the client processes the cancellation in
 * the same synchronous pass that resolves `consume()`, before the code that
 * follows `await ch.consume(...)` can run.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a
 * broker).
 */

import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import type amqp from "amqplib";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (!(await cond())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(25);
    }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (payload: Uint8Array): string => new TextDecoder().decode(payload);

const AMQP_BASIC_CLASS = 60;
const AMQP_BASIC_CONSUME_METHOD = 20;
const AMQP_PROTOCOL_HEADER_LENGTH = 8;
const AMQP_FRAME_HEADER_LENGTH = 7;
const AMQP_METHOD_FRAME = 1;

interface ConsumeGateProxy {
    readonly port: number;
    /** Freeze the broker's replies on every connection from the client's next `basic.consume` on, until `release()`. */
    holdFromNextConsume(): Promise<void>;
    /** Deliver everything held, as one write per connection, and stop holding. */
    release(): void;
    close(): Promise<void>;
}

/** A TCP proxy that freezes the broker-to-client direction at the client's `basic.consume` frame. */
async function startConsumeGateProxy(target: { host: string; port: number }): Promise<ConsumeGateProxy> {
    let armed = false;
    let held = false;
    let resolveHeld: () => void = () => undefined;
    const sockets = new Set<net.Socket>();
    const pending: Array<{ socket: net.Socket; chunks: Buffer[] }> = [];

    const server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        let clientBytes: Buffer = Buffer.alloc(0);
        let headerSkipped = false;
        const mine = { socket: client, chunks: [] as Buffer[] };
        pending.push(mine);

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
                if (armed && isMethod && clientBytes.readUInt16BE(7) === AMQP_BASIC_CLASS && clientBytes.readUInt16BE(9) === AMQP_BASIC_CONSUME_METHOD) {
                    armed = false;
                    held = true;
                    resolveHeld();
                }
                clientBytes = clientBytes.subarray(total);
            }
        };

        client.on("data", (chunk: Buffer) => {
            // Hold must start before the frame reaches the broker: the broker's reply cannot race the flag.
            watch(chunk);
            upstream.write(chunk);
        });
        upstream.on("data", (chunk: Buffer) => {
            if (held) {
                mine.chunks.push(chunk);
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
        holdFromNextConsume() {
            armed = true;
            held = false;
            return new Promise<void>((resolve) => {
                resolveHeld = resolve;
            });
        },
        release() {
            held = false;
            armed = false;
            for (const entry of pending) {
                const chunks = entry.chunks.splice(0);
                if (chunks.length > 0 && !entry.socket.destroyed) {
                    entry.socket.write(Buffer.concat(chunks));
                }
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

describe("AMQP consumer loss while subscribe() has not returned (broker)", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokerUrl = AMQP_URL as string;
    let proxy: ConsumeGateProxy;
    let proxyUrl: string;

    before(async () => {
        const parsed = new URL(brokerUrl);
        proxy = await startConsumeGateProxy({ host: parsed.hostname, port: Number(parsed.port || 5672) });
        proxyUrl = `amqp://${parsed.username}:${parsed.password}@127.0.0.1:${proxy.port}`;
    });

    after(async () => {
        proxy?.release();
        await proxy?.close();
    });

    /** Run `fn` on a channel of a connection that bypasses the proxy, as an operator would. */
    async function withDirectChannel<T>(fn: (ch: amqp.Channel) => Promise<T>): Promise<T> {
        const conn = await connect(brokerUrl);
        try {
            return await fn(await conn.createChannel());
        } finally {
            await conn.close();
        }
    }

    /**
     * Start `subscribe()`, freeze the broker's reply to its `basic.consume`,
     * delete the queue once the broker has registered the consumer, and
     * return with the cancellation held behind the `consume-ok`.
     */
    async function loseConsumerDuringSetup(args: {
        adapter: ReturnType<typeof AmqpAdapter>;
        queue: string;
        pattern: string;
        handler: Parameters<ReturnType<typeof AmqpAdapter>["subscribe"]>[1];
    }): Promise<{ subscribing: Promise<unknown> }> {
        const held = proxy.holdFromNextConsume();
        const subscribing = args.adapter.subscribe([args.pattern], args.handler, { group: "g" });
        await held;
        // The broker registers the consumer when it processes basic.consume; its consume-ok is what is held.
        await waitFor(() => withDirectChannel(async (ch) => (await ch.checkQueue(args.queue)).consumerCount === 1));
        await withDirectChannel((ch) => ch.deleteQueue(args.queue));
        return { subscribing };
    }

    it("reports exactly one consumer-lost after subscribe() setup finishes, then restores the consumer", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const exchange = "early.restore";
        const queue = `${exchange}.g`;
        const adapter = AmqpAdapter({
            url: proxyUrl,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 50, maxDelay: 200 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            const { subscribing } = await loseConsumerDuringSetup({
                adapter,
                queue,
                pattern: `${exchange}.evt`,
                handler: async (event, ack) => {
                    received.push(decode(event.payload));
                    await ack();
                },
            });

            assert.equal(
                events.filter((e) => e.type === "consumer-lost").length,
                0,
                "the broker has already ended the consumer, but the setup has not returned: nothing is reported yet",
            );

            proxy.release();
            await subscribing;

            // The loss is reported once the setup has finished; waiting (instead of asserting at the
            // instant subscribe() returns) keeps the test independent of how the network delivers
            // the two broker frames, while a dropped replay still never produces the event.
            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            const lost = events.filter((e) => e.type === "consumer-lost");
            assert.equal(lost.length, 1, "the loss that preceded the end of setup is reported once");
            const [event] = lost;
            assert.ok(event?.type === "consumer-lost");
            assert.equal(event.queue, queue);
            assert.equal(event.cause, "cancelled");
            assert.equal(event.willRestore, true);

            await waitFor(() => events.some((e) => e.type === "consumer-restored"));
            const restored = events.find((e) => e.type === "consumer-restored");
            assert.ok(restored?.type === "consumer-restored");
            assert.equal(restored.queue, queue);
            assert.equal(restored.attempt, 1);

            await adapter.publish(`${exchange}.evt`, encode("after"));
            await waitFor(() => received.length === 1);
            assert.deepEqual(received, ["after"], "the restored consumer delivers");
            assert.equal(events.filter((e) => e.type === "consumer-lost").length, 1, "one loss produced one event, not a second one from the restore");
        } finally {
            proxy.release();
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("with recovery disabled the early loss is still reported once, with willRestore false, and nothing is restored", { timeout: 60_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const exchange = "early.norecovery";
        const queue = `${exchange}.g`;
        const adapter = AmqpAdapter({
            url: proxyUrl,
            exchange,
            exchangeType: "topic",
            recovery: false,
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect();
        try {
            const { subscribing } = await loseConsumerDuringSetup({ adapter, queue, pattern: `${exchange}.evt`, handler: async (_event, ack) => ack() });
            assert.equal(events.filter((e) => e.type === "consumer-lost").length, 0, "nothing is reported before the setup returns");

            proxy.release();
            await subscribing;

            await waitFor(() => events.some((e) => e.type === "consumer-lost"));
            const lost = events.filter((e) => e.type === "consumer-lost");
            assert.equal(lost.length, 1);
            const [event] = lost;
            assert.ok(event?.type === "consumer-lost");
            assert.equal(event.queue, queue);
            assert.equal(event.cause, "cancelled");
            assert.equal(event.willRestore, false);
            assert.ok(!events.some((e) => e.type === "consumer-restored"), "recovery is off: no restoration");
        } finally {
            proxy.release();
            await adapter.disconnect().catch(() => undefined);
        }
    });
});

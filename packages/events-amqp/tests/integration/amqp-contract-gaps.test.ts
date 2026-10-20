/**
 * Behaviours of the AMQP adapter's external-contract surface that need a real
 * broker to be observed: the default content type on the wire, the arguments
 * of a queue declared from the topology, `skip` mode against a missing queue,
 * and a failing `encode` hook.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a
 * broker). Where the adapter would hide the answer (it strips its own envelope on
 * delivery), a plain amqplib channel is the oracle.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type amqp from "amqplib";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpSerializationError, AmqpTopologyError } from "../../src/errors.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(100);
    }
}

describe("AMQP external-contract surface on a real broker", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;
    const run = randomUUID().slice(0, 8);

    it("an adapter without serialization options publishes application/protobuf and the bytes unchanged", async () => {
        const exchange = `it.default-ct.${run}`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        await adapter.connect();
        const conn = await connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, exchange, "ct.default");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(
                q.queue,
                (m) => {
                    if (m) received.push(m);
                },
                { noAck: true },
            );

            await adapter.publish("ct.default", new Uint8Array([4, 5, 6]));
            await waitFor(() => received.length === 1);

            assert.equal(received[0]?.properties.contentType, "application/protobuf");
            assert.deepEqual(new Uint8Array(received[0]?.content ?? []), new Uint8Array([4, 5, 6]));
        } finally {
            await conn.close();
            await adapter.disconnect();
        }
    });

    it("a queue declared from the topology carries exactly the configured dead-letter arguments", async () => {
        const exchange = `it.dlq-args.${run}`;
        const queue = `it.dlq-args.q.${run}`;
        const dlx = `it.dlq-args.dlx.${run}`;
        const args = { "x-dead-letter-exchange": dlx, "x-dead-letter-routing-key": "dead" };
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "direct",
            recovery: false,
            topology: {
                exchanges: [{ name: dlx, type: "direct" }],
                queues: [{ name: queue, durable: true, arguments: args }],
                bindings: [{ queue, source: exchange, routingKey: "k" }],
            },
        });
        await adapter.connect();
        const conn = await connect(url);
        try {
            // AMQP has no way to read a queue's arguments back, so the oracle is the
            // broker's own equivalence rule: re-declaring with identical arguments
            // succeeds, re-declaring with a different argument fails with 406.
            const same = await conn.createChannel();
            await same.assertQueue(queue, { durable: true, arguments: args });
            await same.close();

            const different = await conn.createChannel();
            different.on("error", () => {});
            await assert.rejects(
                () => different.assertQueue(queue, { durable: true, arguments: { ...args, "x-dead-letter-routing-key": "other" } }),
                (err: unknown) => /PRECONDITION_FAILED|406/.test(String((err as Error).message)),
            );
        } finally {
            const cleanup = await conn.createChannel();
            await cleanup.deleteQueue(queue).catch(() => {});
            await cleanup.deleteExchange(dlx).catch(() => {});
            await cleanup.deleteExchange(exchange).catch(() => {});
            await conn.close().catch(() => {});
            await adapter.disconnect();
        }
    });

    it("skip mode: subscribing to a queue that does not exist fails with AmqpTopologyError and creates nothing", async () => {
        const exchange = `it.skip-missing.${run}`;
        const missing = `it.skip-missing.q.${run}`;
        // The operator owns the exchange in skip mode; create it out of band.
        const conn = await connect(url);
        const ch = await conn.createChannel();
        await ch.assertExchange(exchange, "topic", { durable: false });
        const adapter = AmqpAdapter({
            url,
            exchange,
            recovery: false,
            topologyMode: "skip",
            queueOverrides: { g: { queue: missing } },
        });
        try {
            await adapter.connect();
            await assert.rejects(
                () => adapter.subscribe(["x"], async (_e, ack) => ack(), { group: "g" }),
                (err: unknown) => err instanceof AmqpTopologyError,
            );

            // Nothing was declared on the adapter's behalf: a passive check still finds no queue.
            const probe = await conn.createChannel();
            probe.on("error", () => {});
            await assert.rejects(() => probe.checkQueue(missing));
        } finally {
            await ch.deleteExchange(exchange).catch(() => {});
            await conn.close().catch(() => {});
            await adapter.disconnect();
        }
    });

    // AMQP 0-9-1 delivery-mode: 1 is non-persistent, 2 is persistent. The documented default of
    // `publisherOptions.persistent` is true (deliveryMode 2). A message is fetched with basic.get
    // straight after publish() resolved: once the broker confirmed the publish, the message is
    // already on the queue, so the get needs no waiting.
    for (const [label, publisherOptions, expectedDeliveryMode] of [
        ["by default", {}, 2],
        ["with persistent: false", { persistent: false }, 1],
    ] as const) {
        it(`publish() resolves with the message already on the queue, in a frame with the exchange, routing key, bytes and delivery mode ${expectedDeliveryMode} ${label}`, async () => {
            const exchange = `it.frame.${expectedDeliveryMode}.${randomUUID().slice(0, 6)}`;
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false, publisherOptions });
            await adapter.connect();
            const conn = await connect(url);
            try {
                const ch = await conn.createChannel();
                const q = await ch.assertQueue("", { exclusive: true });
                await ch.bindQueue(q.queue, exchange, "frame.key");

                await adapter.publish("frame.key", new Uint8Array([9, 8, 7]));

                const msg = await ch.get(q.queue, { noAck: true });
                assert.ok(msg, "the message must be on the queue as soon as publish() resolved");
                assert.equal(msg.fields.exchange, exchange);
                assert.equal(msg.fields.routingKey, "frame.key");
                assert.deepEqual(new Uint8Array(msg.content), new Uint8Array([9, 8, 7]));
                assert.equal(msg.properties.deliveryMode, expectedDeliveryMode);
            } finally {
                await conn.close();
                await adapter.disconnect();
            }
        });
    }

    // RabbitMQ documents x-message-ttl, x-max-length, x-dead-letter-exchange and
    // x-dead-letter-routing-key as the queue arguments of those limits. AMQP cannot read a queue's
    // arguments back, so the oracle is the broker's equivalence rule: re-declaring the queue with
    // exactly the expected arguments succeeds and changing any single one fails with 406.
    it("queueOptions become the x-message-ttl, x-max-length and dead-letter arguments of the subscription queue, each one", async () => {
        const exchange = `it.qopts.${run}`;
        const group = "g";
        const queue = `${exchange}.${group}`;
        const dlx = `it.qopts.dlx.${run}`;
        const expected = {
            "x-message-ttl": 60_000,
            "x-max-length": 500,
            "x-dead-letter-exchange": dlx,
            "x-dead-letter-routing-key": "dead",
        };
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: false,
            queueOptions: { messageTtl: 60_000, maxLength: 500, deadLetterExchange: dlx, deadLetterRoutingKey: "dead" },
        });
        await adapter.connect();
        const conn = await connect(url);
        try {
            await adapter.subscribe(["qopts.key"], async (_e, ack) => ack(), { group });

            const same = await conn.createChannel();
            await same.assertQueue(queue, { durable: true, arguments: expected });
            await same.close();

            const changed: Array<[string, Record<string, unknown>]> = [
                ["x-message-ttl", { ...expected, "x-message-ttl": 61_000 }],
                ["x-max-length", { ...expected, "x-max-length": 501 }],
                ["x-dead-letter-exchange", { ...expected, "x-dead-letter-exchange": `${dlx}.other` }],
                ["x-dead-letter-routing-key", { ...expected, "x-dead-letter-routing-key": "other" }],
            ];
            for (const [name, args] of changed) {
                const different = await conn.createChannel();
                different.on("error", () => {});
                await assert.rejects(
                    () => different.assertQueue(queue, { durable: true, arguments: args }),
                    (err: unknown) => /PRECONDITION_FAILED|406/.test(String((err as Error).message)),
                    `a queue declared without exactly the configured ${name} must be refused as inequivalent`,
                );
            }
        } finally {
            await adapter.disconnect();
            const cleanup = await conn.createChannel();
            await cleanup.deleteQueue(queue).catch(() => {});
            await cleanup.deleteExchange(exchange).catch(() => {});
            await conn.close().catch(() => {});
        }
    });

    // The oracle is again the broker's equivalence rule: an exchange re-declared with the same
    // type, durability and auto-delete flag is accepted, and changing any one of them is refused
    // with 406 PRECONDITION_FAILED.
    it("exchangeType and exchangeOptions are the type, durable and auto-delete properties of the declared exchange", async () => {
        const exchange = `it.xopts.${run}`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "direct", exchangeOptions: { durable: false, autoDelete: true }, recovery: false });
        await adapter.connect();
        const conn = await connect(url);
        try {
            const same = await conn.createChannel();
            await same.assertExchange(exchange, "direct", { durable: false, autoDelete: true });
            await same.close();

            const variants: Array<[string, Parameters<amqp.Channel["assertExchange"]>]> = [
                ["exchange type", [exchange, "topic", { durable: false, autoDelete: true }]],
                ["durable flag", [exchange, "direct", { durable: true, autoDelete: true }]],
                ["auto-delete flag", [exchange, "direct", { durable: false, autoDelete: false }]],
            ];
            for (const [name, args] of variants) {
                const different = await conn.createChannel();
                different.on("error", () => {});
                await assert.rejects(
                    () => different.assertExchange(...args),
                    (err: unknown) => /PRECONDITION_FAILED|406/.test(String((err as Error).message)),
                    `an exchange declared with another ${name} must be refused as inequivalent`,
                );
            }
        } finally {
            await adapter.disconnect();
            const cleanup = await conn.createChannel();
            await cleanup.deleteExchange(exchange).catch(() => {});
            await conn.close().catch(() => {});
        }
    });

    // AMQP basic.qos prefetch-count bounds the unacknowledged deliveries of a consumer. The
    // documented default of `consumerOptions.prefetch` is 10. Handlers that never settle hold
    // their deliveries, so the number of handler calls is the number the broker was allowed to
    // push before an acknowledgement.
    for (const [label, consumerOptions, expectedInFlight] of [
        ["the default of 10", {}, 10],
        ["an explicit 3", { prefetch: 3 }, 3],
    ] as const) {
        it(`a consumer holds at most ${label} unacknowledged deliveries`, async () => {
            const exchange = `it.prefetch.${expectedInFlight}.${run}`;
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false, consumerOptions });
            await adapter.connect();
            const conn = await connect(url);
            let held = 0;
            const never = new Promise<void>(() => {});
            try {
                await adapter.subscribe(
                    ["prefetch.key"],
                    async () => {
                        held += 1;
                        await never;
                    },
                    { group: "g" },
                );
                for (let i = 0; i < expectedInFlight + 5; i += 1) {
                    await adapter.publish("prefetch.key", new Uint8Array([i]));
                }
                await waitFor(() => held >= expectedInFlight);
                // The broker would push more at once if the limit were higher: give it the time.
                await sleep(500);
                assert.equal(held, expectedInFlight);
            } finally {
                await adapter.disconnect();
                const cleanup = await conn.createChannel();
                await cleanup.deleteQueue(`${exchange}.g`).catch(() => {});
                await cleanup.deleteExchange(exchange).catch(() => {});
                await conn.close().catch(() => {});
            }
        });
    }

    it("an encode hook that throws rejects the publish with AmqpSerializationError and nothing reaches the broker", async () => {
        const exchange = `it.encode-fail.${run}`;
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: false,
            serialization: {
                encode: () => {
                    throw new Error("cannot encode");
                },
            },
        });
        await adapter.connect();
        const conn = await connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, exchange, "enc.fail");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(
                q.queue,
                (m) => {
                    if (m) received.push(m);
                },
                { noAck: true },
            );

            await assert.rejects(
                () => adapter.publish("enc.fail", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpSerializationError,
            );
            await sleep(300);
            assert.equal(received.length, 0, "a payload that failed to encode must not be sent");
        } finally {
            await conn.close();
            await adapter.disconnect();
        }
    });
});

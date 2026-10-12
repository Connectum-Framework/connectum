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

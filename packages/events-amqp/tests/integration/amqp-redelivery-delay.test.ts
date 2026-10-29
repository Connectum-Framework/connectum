/**
 * A handler that always throws gets the message back at once, as fast as the
 * broker can deliver it. `consumerOptions.redeliveryDelay` (opt-in) spaces the
 * redeliveries out; the default is unchanged.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("redelivery of a message whose handler keeps throwing", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    /** Publish one message to a handler that always throws and count the deliveries over `windowMs`. */
    async function deliveriesWithin(windowMs: number, consumerOptions?: { redeliveryDelay?: number }): Promise<{ count: number; attempts: Set<number> }> {
        const adapter = AmqpAdapter({ url, exchange: `it.redelivery.${randomUUID().slice(0, 8)}`, recovery: { initialConnectMaxRetries: 0 }, ...(consumerOptions ? { consumerOptions } : {}) });
        await adapter.connect();
        let count = 0;
        const attempts = new Set<number>();
        const subscription = await adapter.subscribe(
            ["d.x"],
            async (event) => {
                count += 1;
                attempts.add(event.attempt);
                throw new Error("poison");
            },
            { group: "g" },
        );
        try {
            await adapter.publish("d.x", new TextEncoder().encode("poison"));
            await sleep(windowMs);
            return { count, attempts };
        } finally {
            await subscription.unsubscribe();
            await adapter.disconnect();
        }
    }

    it("without the option the message comes back immediately and repeatedly (unchanged default)", { timeout: 20_000 }, async () => {
        const { count } = await deliveriesWithin(1_000);
        assert.ok(count > 100, `expected a tight redelivery loop, got ${count} deliveries in 1 s`);
    });

    it("with redeliveryDelay the redeliveries are spaced out by about the delay", { timeout: 20_000 }, async () => {
        const { count, attempts } = await deliveriesWithin(1_500, { redeliveryDelay: 300 });
        // The first delivery is at once, then one every ~300 ms: 1 + floor(1500 / 300) = 6 at most.
        assert.ok(count >= 3, `the message must still be redelivered, got ${count}`);
        assert.ok(count <= 8, `expected about one delivery per 300 ms, got ${count} in 1.5 s`);
        assert.deepEqual([...attempts].sort(), [1, 2], "first delivery is attempt 1, every redelivery attempt 2");
    });

    it("unsubscribe() alone returns a held message to the queue at once, while the connection stays open", { timeout: 20_000 }, async () => {
        const exchange = `it.redelivery.${randomUUID().slice(0, 8)}`;
        const adapter = AmqpAdapter({ url, exchange, recovery: { initialConnectMaxRetries: 0 }, consumerOptions: { redeliveryDelay: 60_000 } });
        await adapter.connect();
        const subscription = await adapter.subscribe(
            ["d.x"],
            async () => {
                throw new Error("poison");
            },
            { group: "g" },
        );
        const connection = await connect(url);
        try {
            const channel = await connection.createChannel();
            await adapter.publish("d.x", new TextEncoder().encode("poison"));
            await sleep(300);
            // Held: delivered once, not acknowledged, so it is not a ready message of the queue.
            assert.equal((await channel.checkQueue(`${exchange}.g`)).messageCount, 0);

            await subscription.unsubscribe();

            let ready = 0;
            for (let waited = 0; ready === 0 && waited < 5_000; waited += 100) {
                await sleep(100);
                ready = (await (await connection.createChannel()).checkQueue(`${exchange}.g`)).messageCount;
            }
            assert.equal(ready, 1, "the held message is requeued by unsubscribe(), not after the 60 s delay");
        } finally {
            await connection.close();
            await adapter.disconnect();
        }
    });

    it("shutting down during the wait does not wait for the delay", { timeout: 20_000 }, async () => {
        const adapter = AmqpAdapter({ url, exchange: `it.redelivery.${randomUUID().slice(0, 8)}`, recovery: { initialConnectMaxRetries: 0 }, consumerOptions: { redeliveryDelay: 60_000 } });
        await adapter.connect();
        let deliveries = 0;
        const subscription = await adapter.subscribe(
            ["d.x"],
            async () => {
                deliveries += 1;
                throw new Error("poison");
            },
            { group: "g" },
        );
        try {
            await adapter.publish("d.x", new TextEncoder().encode("poison"));
            await sleep(300);
            assert.equal(deliveries, 1, "the message is held, not redelivered, during the delay");
            const startedAt = Date.now();
            await subscription.unsubscribe();
            await adapter.disconnect();
            assert.ok(Date.now() - startedAt < 5_000, "shutdown must not wait for the 60 s delay");
        } finally {
            await adapter.disconnect();
        }
    });
});

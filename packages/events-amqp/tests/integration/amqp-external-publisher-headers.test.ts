/**
 * Headers of a message published by a plain AMQP client reach the handler as
 * readable text. A table is JSON, not "[object Object]". The oracle for the
 * wire is a plain amqplib channel acting as the external publisher.
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

describe("headers from an external AMQP publisher", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    it("scalars keep their text, tables and arrays arrive as JSON", { timeout: 20_000 }, async () => {
        const exchange = `it.ext-headers.${randomUUID().slice(0, 8)}`;
        const adapter = AmqpAdapter({ url, exchange, recovery: { initialConnectMaxRetries: 0 } });
        await adapter.connect();
        const seen: Array<{ eventId: string; metadata: Record<string, string> }> = [];
        const subscription = await adapter.subscribe(
            ["ext.t"],
            async (event, ack) => {
                seen.push({ eventId: event.eventId, metadata: Object.fromEntries(event.metadata) });
                await ack();
            },
            { group: "g" },
        );
        const connection = await connect(url);
        try {
            const channel = await connection.createChannel();
            channel.publish(exchange, "ext.t", Buffer.from("x"), { headers: { n: 5, flag: true, nested: { a: 1 }, list: [1, "a"], buf: Buffer.from("zz") } });
            for (let waited = 0; seen.length === 0 && waited < 5_000; waited += 50) {
                await sleep(50);
            }
            assert.equal(seen.length, 1);
            assert.deepEqual(seen[0]?.metadata, { n: "5", flag: "true", nested: '{"a":1}', list: '[1,"a"]', buf: "zz" });
            assert.match(seen[0]?.eventId ?? "", /^[0-9a-f-]{36}$/, "no x-event-id and no messageId: the adapter generates the id");
        } finally {
            await connection.close();
            await subscription.unsubscribe();
            await adapter.disconnect();
        }
    });
});

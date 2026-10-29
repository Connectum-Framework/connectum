/**
 * The fake adapter and RabbitMQ route an empty event type the same way on a
 * topic exchange: only a subscription to the empty key receives it, never the
 * wildcards `*` and `>`. The broker is the oracle.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { FakeAmqpAdapter } from "../../src/testing.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("empty event type: fake and RabbitMQ agree on a topic exchange", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;
    const PATTERNS = ["", "*", ">", "a", "a.*", "*.a"];

    it("the same patterns receive the empty key on both", { timeout: 20_000 }, async () => {
        const real = AmqpAdapter({ url, exchange: `it.empty-key.${randomUUID().slice(0, 8)}`, recovery: { initialConnectMaxRetries: 0 } });
        await real.connect();
        const fake = FakeAmqpAdapter();
        await fake.connect();
        const realHits: string[] = [];
        const fakeHits: string[] = [];
        try {
            for (const pattern of PATTERNS) {
                await real.subscribe(
                    [pattern],
                    async (_event, ack) => {
                        realHits.push(pattern);
                        await ack();
                    },
                    { group: `g${PATTERNS.indexOf(pattern)}` },
                );
                await fake.subscribe([pattern], async () => void fakeHits.push(pattern), { group: `g${PATTERNS.indexOf(pattern)}` });
            }
            await real.publish("", new Uint8Array([1]));
            await fake.control.deliver("", new Uint8Array([1]));
            await sleep(500);
            assert.deepEqual(realHits.sort(), [""], "RabbitMQ delivers the empty key only to the empty binding");
            assert.deepEqual(fakeHits.sort(), realHits);
        } finally {
            await real.disconnect();
            await fake.disconnect();
        }
    });
});

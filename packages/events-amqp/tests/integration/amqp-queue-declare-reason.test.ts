/**
 * RabbitMQ 4.3 refuses a non-durable, non-exclusive named queue with a
 * connection exception (`541 INTERNAL_ERROR`, deprecated feature
 * `transient_nonexcl_queues`). The adapter must report that reason, not only
 * amqplib's generic "Channel ended, no reply will be forthcoming".
 *
 * Skipped unless AMQP_TEST_URL is set. A broker that still accepts such a queue
 * (before 4.3) has nothing to report, and the test then skips itself.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpTopologyError } from "../../src/errors.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

describe("a queue declaration the broker answers with a connection exception", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    for (const [mode, recovery] of [
        ["recovery: false", false],
        ["recovery with a bounded startup", { initialConnectMaxRetries: 0 }],
    ] as const) {
        it(`${mode}: AmqpTopologyError keeps the reply code and text of the broker`, { timeout: 20_000 }, async (t) => {
            const adapter = AmqpAdapter({ url, exchange: `it.declare-reason.${randomUUID().slice(0, 8)}`, queueOptions: { durable: false }, recovery });
            await adapter.connect();
            try {
                const outcome = await adapter.subscribe(["q.x"], async () => undefined, { group: "qg" }).then(
                    (subscription) => subscription,
                    (error: unknown) => error,
                );
                if (!(outcome instanceof Error)) {
                    await (outcome as { unsubscribe(): Promise<void> }).unsubscribe();
                    t.skip("this broker accepts a non-durable named queue");
                    return;
                }
                assert.ok(outcome instanceof AmqpTopologyError, `expected AmqpTopologyError, got ${String(outcome)}`);
                assert.match(outcome.message, /Failed to declare queue/);
                assert.match(outcome.message, /541/);
                assert.match(outcome.message, /transient_nonexcl_queues/);
                assert.equal((outcome.cause as { code?: unknown }).code, 541);
                assert.doesNotMatch(outcome.message, /no reply will be forthcoming/);
            } finally {
                await adapter.disconnect();
            }
        });
    }
});

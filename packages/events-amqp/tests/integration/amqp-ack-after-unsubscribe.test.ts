/**
 * A handler that is still running when `unsubscribe()` is called must still be able to acknowledge
 * its message: `EventBus.stop()` unsubscribes first and only then waits for the handlers to drain.
 * Against a real RabbitMQ: the acknowledgement reaches the broker, so the message is not requeued
 * and is not delivered again.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";

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
        await sleep(25);
    }
}

describe("AMQP adapter: acknowledging after unsubscribe()", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    for (const grouped of [true, false] as const) {
        it(`${grouped ? "a named group" : "an automatic group"}: a handler that finishes after unsubscribe() acknowledges its message, which is not redelivered`, { timeout: 40_000 }, async () => {
            const exchange = `ack.after.unsub.${randomUUID().slice(0, 8)}`;
            const group = `g-${randomUUID().slice(0, 8)}`;
            // ack() of this adapter never rejects: an acknowledgement on a closed channel is reported
            // as a `settlement-skipped` lifecycle event, which is therefore what the test must watch.
            const skipped: string[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: false,
                lifecycle: {
                    onLifecycle: (event) => {
                        if (event.type === "settlement-skipped") {
                            skipped.push(event.action);
                        }
                    },
                },
            });
            // A second raw consumer on the same named queue: it receives the message again if the
            // broker took the first delivery back (a closed channel returns unacknowledged messages).
            const raw = await connect(url);
            const rawChannel = await raw.createChannel();

            let started = false;
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let ackError: unknown;
            let acked = false;
            const redelivered: string[] = [];

            try {
                await adapter.connect();
                const subscription = await adapter.subscribe(
                    ["order.created"],
                    async (_event, ack) => {
                        started = true;
                        await gate;
                        try {
                            await ack();
                            acked = true;
                        } catch (error) {
                            ackError = error;
                        }
                    },
                    grouped ? { group } : {},
                );

                if (grouped) {
                    await rawChannel.consume(`${exchange}.${group}`, (msg) => {
                        if (msg !== null) {
                            redelivered.push(msg.fields.redelivered ? "redelivered" : "first");
                            rawChannel.nack(msg, false, false);
                        }
                    });
                }

                await adapter.publish("order.created", new Uint8Array(Buffer.from("in-flight")));
                await waitFor(() => started);

                // What EventBus.stop() does first: unsubscribe while the handler is still running.
                // The handler finishes only after unsubscribe() has returned, as a handler that the
                // drain of stop() is still waiting for does.
                await subscription.unsubscribe();
                release();
                await waitFor(() => acked || ackError !== undefined);
                await sleep(500);

                assert.equal(ackError, undefined, `ack() after unsubscribe() must not fail (got ${String(ackError)})`);
                assert.deepEqual(skipped, [], "the acknowledgement must reach an open channel, not be skipped");
                if (grouped) {
                    assert.deepEqual(redelivered, [], "the acknowledged message must not be delivered again to another consumer of the group");
                }
            } finally {
                release();
                await adapter.disconnect().catch(() => undefined);
                await rawChannel.deleteQueue(`${exchange}.${group}`).catch(() => undefined);
                await rawChannel.deleteExchange(exchange).catch(() => undefined);
                await rawChannel.close().catch(() => undefined);
                await raw.close().catch(() => undefined);
            }
        });
    }
});

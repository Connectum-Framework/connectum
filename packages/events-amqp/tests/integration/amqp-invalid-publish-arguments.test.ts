/**
 * A publish argument the AMQP encoder cannot write (a routing key or message
 * id over 255 bytes, a timestamp that is not a non-negative integer) is a
 * caller error. It must surface as the encoder's own TypeError/RangeError, must
 * not be dressed up as a connection failure, and must not be retried: the same
 * call can never succeed, so a retry budget (or `Infinity`) would only spin.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { AmqpAdapter, isAutoRetriablePublishError } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError } from "../../src/errors.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("invalid publish arguments on a real broker", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;
    const exchange = `it.invalid-args.${randomUUID().slice(0, 8)}`;

    const cases: ReadonlyArray<{ readonly name: string; readonly eventType: string; readonly options?: { messageId?: string; timestamp?: number }; readonly errorClass: typeof TypeError | typeof RangeError }> = [
        { name: "a routing key over 255 bytes", eventType: "k".repeat(300), errorClass: TypeError },
        { name: "a multi-byte routing key over 255 bytes", eventType: "ж".repeat(200), errorClass: TypeError },
        { name: "a message id over 255 characters", eventType: "ok.key", options: { messageId: "m".repeat(300) }, errorClass: TypeError },
        { name: "a NaN timestamp", eventType: "ok.key", options: { timestamp: Number.NaN }, errorClass: TypeError },
        { name: "a fractional timestamp", eventType: "ok.key", options: { timestamp: 1.5 }, errorClass: RangeError },
        { name: "a negative timestamp", eventType: "ok.key", options: { timestamp: -1 }, errorClass: RangeError },
        { name: "an infinite timestamp", eventType: "ok.key", options: { timestamp: Number.POSITIVE_INFINITY }, errorClass: RangeError },
    ];

    for (const { name, eventType, options, errorClass } of cases) {
        it(`${name}: rejects with the encoder's ${errorClass.name}, is not retriable, and publishRetry makes no attempt`, { timeout: 20_000 }, async () => {
            const retries: number[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange,
                recovery: { initialConnectMaxRetries: 0 },
                publishRetry: { maxRetries: 4, initialDelay: 20, maxDelay: 40, onRetry: (info) => retries.push(info.attempt) },
            });
            await adapter.connect();
            try {
                const error = await adapter.publish(eventType, new Uint8Array([1]), options).then(
                    () => null,
                    (e: unknown) => e,
                );
                assert.ok(error instanceof errorClass, `expected ${errorClass.name}, got ${String(error)}`);
                assert.ok(!(error instanceof AmqpConnectionError), "an argument error is not a connection failure");
                assert.equal(isAutoRetriablePublishError(error), false);
                assert.equal(retries.length, 0, "an argument error must not be retried");

                // The channel is untouched: a valid publish right after still works.
                await adapter.publish("ok.key", new Uint8Array([2]));
            } finally {
                await adapter.disconnect();
            }
        });
    }

    it("publishRetry with maxRetries: Infinity does not spin on an invalid argument", { timeout: 20_000 }, async () => {
        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange,
            recovery: { initialConnectMaxRetries: 0 },
            publishRetry: { maxRetries: Number.POSITIVE_INFINITY, initialDelay: 10, maxDelay: 20, onRetry: (info) => retries.push(info.attempt) },
        });
        await adapter.connect();
        try {
            const outcome = await Promise.race([
                adapter.publish("k".repeat(300), new Uint8Array([1])).then(
                    () => "resolved",
                    (e: unknown) => (e instanceof TypeError ? "TypeError" : String(e)),
                ),
                sleep(2_000).then(() => "STILL PENDING"),
            ]);
            assert.equal(outcome, "TypeError");
            assert.equal(retries.length, 0);
        } finally {
            await adapter.disconnect();
        }
    });
});

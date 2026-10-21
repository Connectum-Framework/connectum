/**
 * A handler that is still running when `unsubscribe()` is called must still be able to acknowledge
 * its message: `EventBus.stop()` unsubscribes first and only then waits for the handlers to drain.
 * Against a real broker: the acknowledgement reaches Redis, so the consumer group has no pending
 * entry for the message afterwards and nothing is redelivered.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const modes = [
    { name: "RESP2", protocol: 2, replyMapping: "legacy" },
    { name: "RESP3 native mapping", protocol: 3, replyMapping: "resp3" },
] as const;

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    }
}

describe("Redis adapter: acknowledging after unsubscribe()", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const mode of modes) {
        it(`${mode.name}: a handler that finishes after unsubscribe() acknowledges its message and leaves nothing pending`, { timeout: 30_000 }, async () => {
            const eventType = `integration.redis.ack-after-unsubscribe.${randomUUID()}`;
            const streamKey = `events:${eventType}`;
            const group = `group-${randomUUID()}`;
            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 20, count: 5 },
            });
            const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

            let started = false;
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let ackError: unknown;
            let acked = false;

            try {
                await adapter.connect({ serviceName: `integration-ack-after-unsubscribe-${mode.protocol}` });
                const subscription = await adapter.subscribe(
                    [eventType],
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
                    { group },
                );
                await adapter.publish(eventType, new Uint8Array(Buffer.from("in-flight")));
                await until(() => started, "the handler to start");

                // What EventBus.stop() does first: unsubscribe while the handler is still running.
                const unsubscribing = subscription.unsubscribe();
                release();
                await unsubscribing;
                await until(() => acked || ackError !== undefined, "the handler to settle its acknowledgement");

                assert.equal(ackError, undefined, `ack() after unsubscribe() must not fail (got ${String(ackError)})`);
                const pending = (await control.call("XPENDING", streamKey, group)) as [number, ...unknown[]];
                assert.equal(Number(pending[0]), 0, "the acknowledged message must not stay in the group's pending list");
            } finally {
                release();
                await adapter.disconnect().catch(() => undefined);
                await control.del(streamKey).catch(() => undefined);
                await control.quit().catch(() => undefined);
            }
        });
    }
});

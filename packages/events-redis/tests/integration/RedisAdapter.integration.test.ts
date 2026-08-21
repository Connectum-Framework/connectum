/**
 * Redis broker integration coverage.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. The suite exercises
 * RESP2, RESP3 with legacy reply shapes, and RESP3 with native reply shapes.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";
import type { RedisReplyContext } from "../../src/RedisProtocol.ts";
import { normalizeXPendingReply } from "../../src/RedisProtocol.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const modes = [
    { name: "RESP2", protocol: 2, replyMapping: "legacy" },
    { name: "RESP3 legacy mapping", protocol: 3, replyMapping: "legacy" },
    { name: "RESP3 native mapping", protocol: 3, replyMapping: "resp3" },
] as const;

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

describe("Redis adapter protocol integration", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const mode of modes) {
        it(`${mode.name}: publish, consume, nack/reclaim, ack, and reconnect`, async () => {
            const eventType = `integration.redis.${randomUUID()}`;
            const streamKey = `events:${eventType}`;
            const group = `group-${randomUUID()}`;
            const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
            const firstDelivery = deferred<void>();
            const secondDelivery = deferred<void>();
            const deliveries: { attempt: number; eventId: string }[] = [];

            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 20, count: 5 },
            });
            const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

            try {
                await adapter.connect({ serviceName: `integration-${mode.protocol}-${mode.replyMapping}` });
                const subscription = await adapter.subscribe(
                    [eventType],
                    async (event, ack, nack) => {
                        try {
                            assert.equal(event.eventType, eventType);
                            assert.deepEqual(event.payload, payload);
                            assert.equal(event.metadata.get("trace-id"), "trace-123");
                            assert.ok(Number.isFinite(event.publishedAt.getTime()));
                            deliveries.push({ attempt: event.attempt, eventId: event.eventId });

                            if (deliveries.length === 1) {
                                await nack();
                                firstDelivery.resolve();
                            } else {
                                await ack();
                                secondDelivery.resolve();
                            }
                        } catch (error) {
                            firstDelivery.reject(error);
                            secondDelivery.reject(error);
                            throw error;
                        }
                    },
                    { group },
                );

                await adapter.publish(eventType, payload, { metadata: { "trace-id": "trace-123" } });
                await withTimeout(firstDelivery.promise, `${mode.name} first delivery`);

                const context: RedisReplyContext = { protocol: 2, replyMapping: "legacy" };
                const pending = normalizeXPendingReply(await control.call("XPENDING", streamKey, group, "-", "+", "10"), context);
                assert.ok(pending && pending.length === 1, "first delivery must remain pending after nack");
                const [streamEntryId] = pending[0] as [string, string, number, number];

                // Advance the pending idle clock without sleeping for the adapter's
                // production 30-second reclaim threshold.
                await control.call("XCLAIM", streamKey, group, "holding-consumer", "0", streamEntryId, "IDLE", "31000");
                await withTimeout(secondDelivery.promise, `${mode.name} reclaimed delivery`);

                assert.equal(deliveries.length, 2);
                assert.equal(deliveries[0]?.eventId, deliveries[1]?.eventId);
                assert.equal(deliveries[0]?.attempt, 1);
                assert.ok((deliveries[1]?.attempt ?? 0) >= 2);

                const pendingAfterAck = normalizeXPendingReply(await control.call("XPENDING", streamKey, group, "-", "+", "10"), context);
                assert.deepEqual(pendingAfterAck, []);

                await subscription.unsubscribe();
                await adapter.disconnect();

                const reconnectDelivery = deferred<void>();
                await adapter.connect({ serviceName: `integration-reconnect-${mode.protocol}-${mode.replyMapping}` });
                const reconnectSubscription = await adapter.subscribe(
                    [`${eventType}.reconnect`],
                    async (_event, ack) => {
                        await ack();
                        reconnectDelivery.resolve();
                    },
                    { group: `${group}-reconnect` },
                );
                await adapter.publish(`${eventType}.reconnect`, payload);
                await withTimeout(reconnectDelivery.promise, `${mode.name} reconnect delivery`);
                await reconnectSubscription.unsubscribe();
            } finally {
                await adapter.disconnect();
                await control.quit();
            }
        });
    }

    it("stops instead of retrying an unsupported broker reply", async () => {
        const redisPrototype = Redis.prototype as unknown as { call: (...args: unknown[]) => Promise<unknown> };
        const originalCall = redisPrototype.call;
        const originalConsoleError = console.error;
        const fatalError = deferred<void>();
        const loggedErrors: unknown[][] = [];
        let xreadGroupCalls = 0;
        const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 20 } });

        redisPrototype.call = function (...args: unknown[]): Promise<unknown> {
            if (args[0] === "XREADGROUP") {
                xreadGroupCalls += 1;
                return Promise.resolve(["malformed"]);
            }
            return originalCall.apply(this, args);
        };
        console.error = (...args: unknown[]) => {
            loggedErrors.push(args);
            if (args[0] === "[RedisAdapter] consume loop stopped after an unsupported Redis reply:") {
                fatalError.resolve();
            }
        };

        try {
            await adapter.connect({ serviceName: "integration-malformed-reply" });
            const subscription = await adapter.subscribe([`integration.redis.${randomUUID()}`], async () => {});
            await withTimeout(fatalError.promise, "fatal reply-shape error");
            await new Promise((resolve) => setTimeout(resolve, 100));

            assert.equal(xreadGroupCalls, 1, "unsupported replies must not enter the transient retry loop");
            assert.equal(loggedErrors.length, 1);
            await subscription.unsubscribe();
        } finally {
            console.error = originalConsoleError;
            redisPrototype.call = originalCall;
            await adapter.disconnect();
        }
    });
});

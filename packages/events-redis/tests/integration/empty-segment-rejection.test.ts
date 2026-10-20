/**
 * A subscription pattern with an empty segment is refused before the Redis adapter creates a
 * stream or a consumer group, even when the call also lists a good topic.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

describe("Redis adapter empty-segment rejection", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const [label, pattern] of [
        ["the empty string", ""],
        ["an empty segment between dots", "a..b"],
        ["a leading dot", ".a"],
        ["a trailing dot", "a."],
        ["a lone dot", "."],
    ] as const) {
        it(`subscribe() rejects ${label} and creates no stream`, async () => {
            const good = `plain.${randomUUID().replaceAll("-", "")}`;
            const observer = new Redis(url);
            const adapter = RedisAdapter({ url });
            await adapter.connect({ serviceName: "integration-empty-segment-rejection" });
            try {
                const before = (await observer.keys("events:*")).sort();

                await assert.rejects(
                    adapter.subscribe([good, pattern], async () => undefined, { group: `g-${randomUUID()}` }),
                    (error: unknown) => error instanceof TypeError && error.message.startsWith(`RedisAdapter: subscription pattern "${pattern}" has an empty segment (`),
                );

                assert.deepEqual((await observer.keys("events:*")).sort(), before, "neither the good topic nor the bad one got a stream");
                assert.equal(await observer.exists(`events:${good}`), 0);
            } finally {
                await adapter.disconnect();
                observer.disconnect();
            }
        });
    }

    it("subscribe() still creates the stream of a literal topic", async () => {
        const good = `plain.${randomUUID().replaceAll("-", "")}`;
        const observer = new Redis(url);
        const adapter = RedisAdapter({ url });
        await adapter.connect({ serviceName: "integration-empty-segment-rejection" });
        try {
            const subscription = await adapter.subscribe([good], async () => undefined, { group: `g-${randomUUID()}` });
            assert.equal(await observer.exists(`events:${good}`), 1);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
            observer.disconnect();
        }
    });
});

/**
 * A Redis stream key is an arbitrary string (Redis documentation, "Keys": binary-safe, any sequence
 * of bytes up to 512 MB), so a topic name with an empty segment is a working topic: the adapter
 * subscribes to it and delivers what is published to it.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

describe("Redis adapter topics with an empty segment", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    const unique = randomUUID().replaceAll("-", "");
    for (const [label, topic] of [
        ["an empty segment between dots", `${unique}..b`],
        ["a leading dot", `.${unique}`],
        ["a trailing dot", `${unique}.`],
    ] as const) {
        it(`subscribes to a topic with ${label} and receives what is published to it`, async () => {
            const observer = new Redis(url);
            const adapter = RedisAdapter({ url });
            // Setup sits inside the cleanup boundary and every disconnect has its own `finally`, so a
            // failed connect or a failed cleanup call never leaves a client retrying in the background.
            try {
                await adapter.connect({ serviceName: "integration-empty-segment-topics" });
                const received: string[] = [];
                const subscription = await adapter.subscribe([topic], async (event, ack) => {
                    received.push(`${event.eventType}:${Buffer.from(event.payload).toString()}`);
                    await ack();
                }, { group: `g-${randomUUID()}` });
                assert.equal(await observer.exists(`events:${topic}`), 1, "the subscription created the stream of the topic");

                await adapter.publish(topic, new Uint8Array(Buffer.from("hello")));

                const deadline = Date.now() + 10_000;
                while (received.length === 0 && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                assert.deepEqual(received, [`${topic}:hello`]);
                await subscription.unsubscribe();
            } finally {
                try {
                    await observer.del(`events:${topic}`);
                } finally {
                    try {
                        await adapter.disconnect();
                    } finally {
                        observer.disconnect();
                    }
                }
            }
        });
    }
});

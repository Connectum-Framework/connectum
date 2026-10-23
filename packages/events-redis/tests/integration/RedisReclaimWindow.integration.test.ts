/**
 * The idle window of the Redis adapter's reclaim of stale pending entries, against a real broker.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. The suite runs in
 * RESP2, RESP3 with legacy reply shapes, and RESP3 with native reply shapes.
 *
 * A message whose handler did not acknowledge it stays pending and is delivered again once it has
 * been idle for 30 s. The redelivery tests cannot tell 30 s from a slightly longer window (their
 * 8 s wait absorbs it), so a control connection in `MONITOR` mode records the commands the broker
 * receives and the window each reclaim (`XAUTOCLAIM`) asks for is read from the command itself.
 * How often the loop looks is an internal detail and is not asserted; that it keeps looking is.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const modes = [
    { name: "RESP2", protocol: 2, replyMapping: "legacy" },
    { name: "RESP3 legacy mapping", protocol: 3, replyMapping: "legacy" },
    { name: "RESP3 native mapping", protocol: 3, replyMapping: "resp3" },
] as const;

/** Reclaim passes to wait for: enough to show that the loop keeps reclaiming, not just once. */
const OBSERVED_RECLAIMS = 4;

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    }
}

describe("Redis adapter reclaim window", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const mode of modes) {
        it(`${mode.name}: the consume loop keeps reclaiming entries that have been idle for 30 s`, async () => {
            const eventType = `integration.redis.reclaim.window.${randomUUID()}`;
            const streamKey = `events:${eventType}`;
            const group = `group-${randomUUID()}`;

            // An idle stream: every XREADGROUP times out after blockMs, so the loop runs quickly without any message.
            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 20, count: 5 },
            });
            const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });
            const monitor = (await control.monitor()) as unknown as { on(event: "monitor", listener: (time: string, args: string[]) => void): void; disconnect(): void };
            /** The `min-idle-time` argument of every XAUTOCLAIM of this group: XAUTOCLAIM key group consumer min-idle-time start. */
            const minIdleTimes: string[] = [];
            monitor.on("monitor", (_time, args) => {
                if (!args.includes(group)) return;
                if (String(args[0]).toUpperCase() === "XAUTOCLAIM") {
                    minIdleTimes.push(String(args[4]));
                }
            });

            try {
                await adapter.connect({ serviceName: `integration-reclaim-window-${mode.protocol}-${mode.replyMapping}` });
                const subscription = await adapter.subscribe([eventType], async (_event, ack) => ack(), { group });
                try {
                    await until(() => minIdleTimes.length >= OBSERVED_RECLAIMS, `${OBSERVED_RECLAIMS} reclaim passes`);
                } finally {
                    await subscription.unsubscribe();
                }

                assert.deepEqual(new Set(minIdleTimes), new Set(["30000"]), "XAUTOCLAIM must ask for entries idle for 30 s (30000 ms)");
            } finally {
                monitor.disconnect();
                await adapter.disconnect().catch(() => undefined);
                await control.del(streamKey).catch(() => undefined);
                await control.quit().catch(() => undefined);
            }
        });
    }
});

/**
 * How often the Redis adapter looks for stale pending entries, against a real broker.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. The suite runs in
 * RESP2, RESP3 with legacy reply shapes, and RESP3 with native reply shapes.
 *
 * The consume loop reads new entries with `XREADGROUP` and, on every fifth loop
 * iteration, first reclaims stale pending entries with `XAUTOCLAIM`. A control
 * connection in `MONITOR` mode records the commands the broker receives, in the
 * order it executes them, so the period is observed on the wire instead of
 * read from the adapter's own state: four reads, then the first reclaim, and
 * after that one reclaim per five reads. The same recording shows the idle
 * window each reclaim asks for: 30 s, the time after which a nack'd entry is
 * delivered again.
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

describe("Redis adapter reclaim interval", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const mode of modes) {
        it(`${mode.name}: entries idle for 30 s are looked for on every fifth loop iteration`, async () => {
            const eventType = `integration.redis.reclaim.interval.${randomUUID()}`;
            const streamKey = `events:${eventType}`;
            const group = `group-${randomUUID()}`;

            // An idle stream: every XREADGROUP times out after blockMs, so each loop iteration is exactly one read.
            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 20, count: 5 },
            });
            const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });
            const monitor = (await control.monitor()) as unknown as { on(event: "monitor", listener: (time: string, args: string[]) => void): void; disconnect(): void };
            /** The consume loop's commands of this group, in the broker's execution order. */
            const commands: Array<"read" | "reclaim"> = [];
            /** The `min-idle-time` argument of every XAUTOCLAIM: XAUTOCLAIM key group consumer min-idle-time start. */
            const minIdleTimes: string[] = [];
            monitor.on("monitor", (_time, args) => {
                if (!args.includes(group)) return;
                const name = String(args[0]).toUpperCase();
                if (name === "XREADGROUP") {
                    commands.push("read");
                } else if (name === "XAUTOCLAIM") {
                    commands.push("reclaim");
                    minIdleTimes.push(String(args[4]));
                }
            });

            try {
                await adapter.connect({ serviceName: `integration-reclaim-interval-${mode.protocol}-${mode.replyMapping}` });
                const subscription = await adapter.subscribe([eventType], async (_event, ack) => ack(), { group });
                try {
                    await until(() => commands.filter((command) => command === "reclaim").length >= OBSERVED_RECLAIMS, `${OBSERVED_RECLAIMS} reclaim passes`);
                } finally {
                    await subscription.unsubscribe();
                }

                // Reads between consecutive reclaims; the first count is the reads before the first reclaim.
                const readsBefore: number[] = [];
                let reads = 0;
                for (const command of commands) {
                    if (command === "read") {
                        reads += 1;
                    } else {
                        readsBefore.push(reads);
                        reads = 0;
                    }
                }
                // The reclaim of iteration 5 runs before that iteration's read, which therefore counts towards the next gap.
                assert.deepEqual(
                    readsBefore.slice(0, OBSERVED_RECLAIMS),
                    [4, 5, 5, 5],
                    `a reclaim must precede every fifth read of the loop (reads before each reclaim; commands seen: ${commands.slice(0, 24).join(" ")})`,
                );
                // A nack'd entry is redelivered once it has been idle for 30 s. The redelivery tests cannot tell
                // 30 s from a slightly longer window (their 8 s wait absorbs it), so the window the broker is asked
                // for is read from the command itself.
                assert.ok(minIdleTimes.length >= OBSERVED_RECLAIMS);
                assert.deepEqual(
                    new Set(minIdleTimes),
                    new Set(["30000"]),
                    "XAUTOCLAIM must ask for entries idle for 30 s (30000 ms)",
                );
            } finally {
                monitor.disconnect();
                await adapter.disconnect().catch(() => undefined);
                await control.del(streamKey).catch(() => undefined);
                await control.quit().catch(() => undefined);
            }
        });
    }
});

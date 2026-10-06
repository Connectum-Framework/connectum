/**
 * Redis Streams reclaim of stale pending entries against a real broker.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. The suite runs in
 * RESP2, RESP3 with legacy reply shapes, and RESP3 with native reply shapes.
 *
 * An entry that was nack'd (or whose handler threw) stays in the group's
 * pending list and is claimed again by `XAUTOCLAIM` once it has been idle for
 * 30 s. The tests do not wait that long: a control connection hands the
 * pending entries to another consumer with `XCLAIM ... IDLE 31000`, which makes
 * them look idle for 31 s to the next reclaim pass.
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

const STALE_IDLE_MS = "31000";

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    }
}

/** Entry ids that are in the group's pending list, oldest first. */
async function pendingIds(control: Redis, streamKey: string, group: string): Promise<string[]> {
    const rows = (await control.call("XPENDING", streamKey, group, "-", "+", "100")) as [string, string, number, number][];
    return rows.map(([id]) => id);
}

/** Make every pending entry look idle for 31 s, so the next reclaim pass takes it. */
async function makeStale(control: Redis, streamKey: string, group: string): Promise<void> {
    for (const id of await pendingIds(control, streamKey, group)) {
        await control.call("XCLAIM", streamKey, group, "holding-consumer", "0", id, "IDLE", STALE_IDLE_MS);
    }
}

/** Collect what the adapter prints through console.error / console.warn while `run` executes. */
async function captureConsole(run: () => Promise<void>): Promise<{ errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
        errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    };
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    };
    try {
        await run();
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
    return { errors, warnings };
}

describe("Redis adapter reclaim integration", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const mode of modes) {
        it(`${mode.name}: a handler that always throws on one reclaimed entry does not stop the entries behind it`, async () => {
            const eventType = `integration.redis.reclaim.${randomUUID()}`;
            const streamKey = `events:${eventType}`;
            const group = `group-${randomUUID()}`;
            const deliveries = new Map<string, number[]>();
            const attemptsOf = (payload: string): number[] => deliveries.get(payload) ?? [];

            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 20, count: 5 },
            });
            const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

            try {
                await adapter.connect({ serviceName: `integration-reclaim-${mode.protocol}-${mode.replyMapping}` });
                const { errors, warnings } = await captureConsole(async () => {
                    const subscription = await adapter.subscribe(
                        [eventType],
                        async (event, ack) => {
                            const payload = Buffer.from(event.payload).toString();
                            const seen = [...attemptsOf(payload), event.attempt];
                            deliveries.set(payload, seen);
                            if (payload === "poison") {
                                throw new Error("poison entry always fails");
                            }
                            if (payload === "transient" && seen.length === 1) {
                                throw new Error("transient entry fails on its first delivery");
                            }
                            await ack();
                        },
                        { group },
                    );

                    try {
                        for (const payload of ["poison", "transient", "healthy"]) {
                            await adapter.publish(eventType, new Uint8Array(Buffer.from(payload)));
                        }
                        await until(() => attemptsOf("poison").length === 1 && attemptsOf("transient").length === 1 && attemptsOf("healthy").length === 1, "first delivery of all three entries");
                        // The healthy entry is acknowledged; the two failed ones stay pending, poison first.
                        await until(async () => (await pendingIds(control, streamKey, group)).length === 2, "acknowledgement of the healthy entry");

                        await makeStale(control, streamKey, group);

                        await until(() => attemptsOf("transient").length >= 2, "redelivery of the transient entry behind the poison one");
                        await until(() => attemptsOf("poison").length >= 2, "redelivery of the poison entry");
                    } finally {
                        await subscription.unsubscribe();
                    }
                });

                assert.deepEqual(attemptsOf("healthy"), [1], "an acknowledged entry is never redelivered");
                assert.ok((attemptsOf("transient")[1] ?? 0) >= 2, `the redelivery must carry the delivery count (got ${attemptsOf("transient")})`);

                const stillPending = await pendingIds(control, streamKey, group);
                const entries = (await control.call("XRANGE", streamKey, "-", "+")) as [string, string[]][];
                const idOf = (payload: string): string => {
                    const entry = entries.find(([, fields]) => Buffer.from(fields[fields.indexOf("payload") + 1] ?? "", "base64").toString() === payload);
                    assert.ok(entry, `entry ${payload} must exist in the stream`);
                    return entry[0];
                };
                assert.deepEqual(stillPending, [idOf("poison")], "only the poison entry stays pending; the transient entry was acknowledged on redelivery");

                assert.ok(
                    errors.some((line) => line.includes("handler error for entry") && line.includes(idOf("poison"))),
                    `the failure of a reclaimed entry must be logged with its entry id (got ${JSON.stringify(errors)})`,
                );
                assert.ok(!warnings.some((line) => line.includes("XAUTOCLAIM")), `a handler failure is not an XAUTOCLAIM failure (got ${JSON.stringify(warnings)})`);
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await control.del(streamKey).catch(() => undefined);
                await control.quit().catch(() => undefined);
            }
        });

        it(`${mode.name}: stale entries behind a long run of recently delivered ones are still reclaimed`, async () => {
            // XAUTOCLAIM inspects at most COUNT * 10 pending entries per call. With COUNT 2 and
            // twenty fresh pending entries in front, the six stale ones can only be reached by
            // continuing the scan from the cursor the previous call returned.
            const eventType = `integration.redis.reclaim.window.${randomUUID()}`;
            const streamKey = `events:${eventType}`;
            const group = `group-${randomUUID()}`;
            const payloads = Array.from({ length: 26 }, (_, index) => `entry-${String(index).padStart(2, "0")}`);
            const deliveries = new Map<string, number>();

            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 20, count: 2 },
            });
            const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

            try {
                await adapter.connect({ serviceName: `integration-reclaim-window-${mode.protocol}-${mode.replyMapping}` });
                const subscription = await adapter.subscribe(
                    [eventType],
                    async (event, ack) => {
                        const payload = Buffer.from(event.payload).toString();
                        const seen = (deliveries.get(payload) ?? 0) + 1;
                        deliveries.set(payload, seen);
                        if (seen === 1) {
                            throw new Error("every entry fails on its first delivery");
                        }
                        await ack();
                    },
                    { group },
                );

                try {
                    for (const payload of payloads) {
                        await adapter.publish(eventType, new Uint8Array(Buffer.from(payload)));
                    }
                    await until(() => payloads.every((payload) => deliveries.get(payload) === 1), "first delivery of every entry");

                    const pending = await pendingIds(control, streamKey, group);
                    assert.equal(pending.length, payloads.length, "every failed entry must be pending");
                    for (const id of pending.slice(20)) {
                        await control.call("XCLAIM", streamKey, group, "holding-consumer", "0", id, "IDLE", STALE_IDLE_MS);
                    }

                    await until(() => payloads.slice(20).every((payload) => (deliveries.get(payload) ?? 0) >= 2), "redelivery of the stale entries behind the scan window");
                    await until(async () => (await pendingIds(control, streamKey, group)).length === 20, "acknowledgement of the redelivered stale entries");
                    assert.deepEqual(
                        payloads.slice(0, 20).map((payload) => deliveries.get(payload)),
                        Array.from({ length: 20 }, () => 1),
                        "entries that are not idle long enough must not be redelivered",
                    );
                } finally {
                    await subscription.unsubscribe();
                }
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await control.del(streamKey).catch(() => undefined);
                await control.quit().catch(() => undefined);
            }
        });
    }
});

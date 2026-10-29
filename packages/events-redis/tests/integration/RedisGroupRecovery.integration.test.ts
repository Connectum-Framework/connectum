/**
 * A consumer resumes after Redis loses its consumer group.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. The group is lost the way a restart
 * without persistence or a failover to an empty replica loses it: a control connection deletes
 * the stream key (which removes the stream and every group on it) or destroys the group.
 * The suite runs in RESP2, RESP3 with legacy reply shapes, and RESP3 with native reply shapes.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { EventSubscription } from "@connectum/events";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";
import type { RedisLifecycleEvent } from "../../src/types.ts";
import { withCleanup } from "../helpers/cleanup.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const modes = [
    { name: "RESP2", protocol: 2, replyMapping: "legacy" },
    { name: "RESP3 legacy mapping", protocol: 3, replyMapping: "legacy" },
    { name: "RESP3 native mapping", protocol: 3, replyMapping: "resp3" },
] as const;

async function until(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    }
}

/** Cleanup steps shared by the tests: stop the subscription, close the adapter, drop the stream, close the control client. */
function controlCleanup(control: Redis, streamKey: string, adapter: { disconnect(): Promise<void> }, subscription: () => EventSubscription | undefined): ReadonlyArray<() => unknown> {
    return [() => subscription()?.unsubscribe(), () => adapter.disconnect(), () => control.del(streamKey), () => control.quit(), () => control.disconnect()];
}

/** Collect what the adapter prints through console.error / console.warn while `run` executes. */
async function captureConsole(run: () => Promise<void>): Promise<{ errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    const text = (args: unknown[]): string => args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
    console.error = (...args: unknown[]) => {
        errors.push(text(args));
    };
    console.warn = (...args: unknown[]) => {
        warnings.push(text(args));
    };
    try {
        await run();
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
    return { errors, warnings };
}

describe("Redis consumer group recovery", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    for (const mode of modes) {
        it(`${mode.name}: delivers events published after the stream and its group were deleted`, async () => {
            const topic = `integration.group-recovery.${randomUUID()}`;
            const streamKey = `events:${topic}`;
            const group = `group-${randomUUID()}`;
            const received: string[] = [];
            const lifecycle: RedisLifecycleEvent[] = [];
            const control = new Redis(url);
            const adapter = RedisAdapter({
                url,
                redisOptions: { protocol: mode.protocol, replyMapping: mode.replyMapping },
                brokerOptions: { blockMs: 100 },
                lifecycle: { onLifecycle: (event) => void lifecycle.push(event) },
            });
            const publish = (text: string): Promise<void> => adapter.publish(topic, new TextEncoder().encode(text));

            const output = await captureConsole(async () => {
                let subscription: EventSubscription | undefined;
                await withCleanup(
                    async () => {
                        await adapter.connect({ serviceName: "integration-group-recovery" });
                        subscription = await adapter.subscribe(
                            [topic],
                            async (event, ack) => {
                                received.push(Buffer.from(event.payload).toString());
                                await ack();
                            },
                            { group },
                        );
                        await publish("before-loss");
                        await until(() => received.includes("before-loss"), "delivery before the loss");

                        await control.del(streamKey);
                        assert.equal(await control.exists(streamKey), 0);
                        await publish("after-loss");

                        await until(() => received.includes("after-loss"), "delivery after the group was lost");
                        assert.deepEqual(received, ["before-loss", "after-loss"]);

                        const groups = (await control.call("XINFO", "GROUPS", streamKey)) as unknown[];
                        assert.equal(groups.length, 1, "the group exists again");
                    },
                    controlCleanup(control, streamKey, adapter, () => subscription),
                );
            });

            const recreated = lifecycle.filter((event) => event.type === "group-recreated");
            assert.equal(recreated.length, 1, "one group, one event");
            assert.deepEqual(
                { ...recreated[0] },
                { type: "group-recreated", group, stream: streamKey, connection: { group, patterns: [topic] } },
            );
            assert.equal(output.warnings.filter((line) => line.includes("re-created consumer group")).length, 1);
            const noGroupLines = output.errors.filter((line) => line.includes("NOGROUP"));
            assert.ok(noGroupLines.length <= 1, `NOGROUP must not repeat, saw ${noGroupLines.length} lines`);
        });
    }

    it("replays the stream from its beginning when only the group was destroyed", async () => {
        const topic = `integration.group-recovery.${randomUUID()}`;
        const streamKey = `events:${topic}`;
        const group = `group-${randomUUID()}`;
        const received: string[] = [];
        const control = new Redis(url);
        const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 100 } });
        const publish = (text: string): Promise<void> => adapter.publish(topic, new TextEncoder().encode(text));

        await captureConsole(async () => {
            let subscription: EventSubscription | undefined;
            await withCleanup(
                async () => {
                    await adapter.connect();
                    subscription = await adapter.subscribe(
                        [topic],
                        async (event, ack) => {
                            received.push(Buffer.from(event.payload).toString());
                            await ack();
                        },
                        { group },
                    );
                    await publish("first");
                    await until(() => received.includes("first"), "first delivery");

                    await control.call("XGROUP", "DESTROY", streamKey, group);
                    await publish("second");

                    // A re-created group starts at the beginning of the stream, so every entry the stream still
                    // holds is delivered; entries that were already delivered are delivered again (at-least-once).
                    await until(() => received.includes("second"), "delivery after the group was destroyed");
                    assert.deepEqual(received, ["first", "first", "second"]);
                },
                controlCleanup(control, streamKey, adapter, () => subscription),
            );
        });
    });

    it("re-creates the group when the reclaim pass meets NOGROUP", async () => {
        const topic = `integration.group-recovery.${randomUUID()}`;
        const streamKey = `events:${topic}`;
        const group = `group-${randomUUID()}`;
        const control = new Redis(url);
        const lifecycle: RedisLifecycleEvent[] = [];
        // The reclaim pass runs at the start of every fifth loop iteration, and the read that precedes
        // it would meet a lost group first. So the group is destroyed right before the first
        // XAUTOCLAIM is sent: the reclaim pass is the one that sees NOGROUP.
        const redisPrototype = Redis.prototype as unknown as { call: (...args: unknown[]) => Promise<unknown> };
        const originalCall = redisPrototype.call;
        let destroyed = false;
        redisPrototype.call = async function (this: Redis, ...args: unknown[]): Promise<unknown> {
            if (args[0] === "XAUTOCLAIM" && !destroyed) {
                destroyed = true;
                await control.call("XGROUP", "DESTROY", streamKey, group);
            }
            return originalCall.apply(this, args);
        };
        const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 20 }, lifecycle: { onLifecycle: (event) => void lifecycle.push(event) } });

        try {
            const output = await captureConsole(async () => {
                let subscription: EventSubscription | undefined;
                await withCleanup(
                    async () => {
                        await adapter.connect();
                        subscription = await adapter.subscribe([topic], async (_event, ack) => ack(), { group });
                        await until(() => lifecycle.some((event) => event.type === "group-recreated"), "group re-created");
                        const groups = (await control.call("XINFO", "GROUPS", streamKey)) as unknown[];
                        assert.equal(groups.length, 1);
                    },
                    controlCleanup(control, streamKey, adapter, () => subscription),
                );
            });
            assert.equal(destroyed, true);
            assert.deepEqual(
                output.errors.filter((line) => line.includes("consume loop error")),
                [],
                "the reclaim pass recovered the group, so the read never saw NOGROUP",
            );
        } finally {
            redisPrototype.call = originalCall;
        }
    });
});

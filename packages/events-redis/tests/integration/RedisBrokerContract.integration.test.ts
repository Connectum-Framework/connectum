/**
 * Documented Redis adapter behaviour that only a real broker can confirm.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. The expectations come from the
 * adapter guide (stream names and retention, redelivery of pending entries, consumer group
 * start position), the `RedisBrokerOptions` reference (defaults and meaning of `maxLen`,
 * `blockMs`, `count`) and the Redis command reference (`XADD`, `XREADGROUP`, `XACK`,
 * `XPENDING`, `CLIENT LIST`), not from the adapter's own output.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { RawEvent } from "@connectum/events";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

/** Record the arguments of the named commands the adapter sends through `call()` while `run` executes. */
async function recordCommands(commands: readonly string[], run: () => Promise<void>): Promise<Map<string, string[][]>> {
    const prototype = Redis.prototype as unknown as { call: (...args: unknown[]) => Promise<unknown> };
    const originalCall = prototype.call;
    const recorded = new Map<string, string[][]>();
    prototype.call = function (...args: unknown[]): Promise<unknown> {
        const name = String(args[0]);
        if (commands.includes(name)) {
            recorded.set(name, [...(recorded.get(name) ?? []), args.slice(1).map(String)]);
        }
        return originalCall.apply(this, args);
    };
    try {
        await run();
    } finally {
        prototype.call = originalCall;
    }
    return recorded;
}

/** Entry ids in the group's pending list. */
async function pendingIds(control: Redis, streamKey: string, group: string): Promise<string[]> {
    const rows = (await control.call("XPENDING", streamKey, group, "-", "+", "100")) as [string, string, number, number][];
    return rows.map(([id]) => id);
}

describe("Redis adapter documented broker behaviour", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    /** Run a test body with a control connection and a unique topic whose stream is removed afterwards. */
    async function withTopic(body: (context: { control: Redis; topic: string; streamKey: string; group: string }) => Promise<void>): Promise<void> {
        const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });
        const topic = `integration.redis.contract.${randomUUID()}`;
        const streamKey = `events:${topic}`;
        try {
            await body({ control, topic, streamKey, group: `group-${randomUUID()}` });
        } finally {
            await control.del(streamKey).catch(() => undefined);
            await control.quit().catch(() => undefined);
        }
    }

    /** Names of the clients connected to the broker, from CLIENT LIST. */
    async function clientNames(control: Redis): Promise<string[]> {
        const listing = (await control.client("LIST")) as string;
        return listing
            .split("\n")
            .flatMap((line) => line.split(" "))
            .filter((field) => field.startsWith("name="))
            .map((field) => field.slice("name=".length));
    }

    describe("connection name", () => {
        it("names the connection after the service identifier given to connect()", async () => {
            await withTopic(async ({ control }) => {
                const serviceName = `order.v1.${randomUUID().slice(0, 8)}@test-host`;
                const adapter = RedisAdapter({ url });
                try {
                    await adapter.connect({ serviceName });
                    assert.ok((await clientNames(control)).includes(serviceName), `CLIENT LIST must show a connection named ${serviceName}`);
                } finally {
                    await adapter.disconnect();
                }
            });
        });

        it("an explicit redisOptions.connectionName wins over the derived service identifier", async () => {
            await withTopic(async ({ control }) => {
                const suffix = randomUUID().slice(0, 8);
                const explicit = `explicit-${suffix}`;
                const derived = `derived-${suffix}@test-host`;
                const adapter = RedisAdapter({ url, redisOptions: { connectionName: explicit } });
                try {
                    await adapter.connect({ serviceName: derived });
                    const names = await clientNames(control);
                    assert.ok(names.includes(explicit), `CLIENT LIST must show the explicit name ${explicit}`);
                    assert.ok(!names.includes(derived), "the derived identifier must not be used when a name is set explicitly");
                } finally {
                    await adapter.disconnect();
                }
            });
        });
    });

    describe("publishing", () => {
        it("writes each event to the stream events:<topic>", async () => {
            await withTopic(async ({ control, topic, streamKey }) => {
                const adapter = RedisAdapter({ url });
                try {
                    await adapter.connect({ serviceName: "integration-stream-name" });
                    await adapter.publish(topic, new Uint8Array([1]));
                    await adapter.publish(topic, new Uint8Array([2]));
                    assert.equal(await control.xlen(streamKey), 2);
                } finally {
                    await adapter.disconnect();
                }
            });
        });

        it("approximate MAXLEN trimming is requested only when brokerOptions.maxLen is set, and bounds retention", async () => {
            await withTopic(async ({ control, topic, streamKey }) => {
                const trimmed = RedisAdapter({ url, brokerOptions: { maxLen: 10 } });
                const unlimited = RedisAdapter({ url });
                try {
                    await trimmed.connect({ serviceName: "integration-maxlen" });
                    await unlimited.connect({ serviceName: "integration-unlimited" });

                    const recorded = await recordCommands(["XADD"], async () => {
                        for (let index = 0; index < 250; index += 1) {
                            await trimmed.publish(topic, new Uint8Array([index % 256]));
                        }
                        await unlimited.publish(`${topic}.unlimited`, new Uint8Array([1]));
                    });

                    const xadds = recorded.get("XADD") ?? [];
                    assert.deepEqual(xadds[0]?.slice(0, 5), [streamKey, "MAXLEN", "~", "10", "*"], "XADD key MAXLEN ~ threshold *");
                    const unlimitedXadd = xadds.at(-1) ?? [];
                    assert.ok(!unlimitedXadd.includes("MAXLEN"), "without maxLen the stream is not trimmed");
                    assert.deepEqual(unlimitedXadd.slice(0, 2), [`${streamKey}.unlimited`, "*"]);

                    const length = await control.xlen(streamKey);
                    assert.ok(length < 250, `approximate trimming must have removed old entries (length ${length})`);
                    assert.ok(length >= 10, `approximate trimming never goes below the threshold (length ${length})`);
                    await control.del(`${streamKey}.unlimited`);
                } finally {
                    await trimmed.disconnect();
                    await unlimited.disconnect();
                }
            });
        });
    });

    describe("consuming", () => {
        it("reads with COUNT and BLOCK from brokerOptions, defaulting to 10 and 5000 ms", async () => {
            await withTopic(async ({ topic, streamKey, group }) => {
                const custom = RedisAdapter({ url, brokerOptions: { blockMs: 25, count: 3 } });
                const defaults = RedisAdapter({ url });
                try {
                    await custom.connect({ serviceName: "integration-read-custom" });
                    await defaults.connect({ serviceName: "integration-read-defaults" });

                    const recorded = await recordCommands(["XREADGROUP"], async () => {
                        const first = await custom.subscribe([topic], async () => undefined, { group });
                        await sleep(150);
                        await first.unsubscribe();
                        const second = await defaults.subscribe([topic], async () => undefined, { group: `${group}-defaults` });
                        await sleep(150);
                        await second.unsubscribe();
                    });

                    const reads = recorded.get("XREADGROUP") ?? [];
                    const customRead = reads.find((args) => args[1] === group);
                    const defaultRead = reads.find((args) => args[1] === `${group}-defaults`);
                    assert.ok(customRead && defaultRead, "both subscriptions must have issued XREADGROUP");
                    // XREADGROUP GROUP group consumer COUNT n BLOCK ms STREAMS key >
                    assert.deepEqual([customRead[0], customRead[1], ...customRead.slice(3)], ["GROUP", group, "COUNT", "3", "BLOCK", "25", "STREAMS", streamKey, ">"]);
                    assert.deepEqual([defaultRead[0], defaultRead[1], ...defaultRead.slice(3)], ["GROUP", `${group}-defaults`, "COUNT", "10", "BLOCK", "5000", "STREAMS", streamKey, ">"]);
                } finally {
                    await custom.disconnect();
                    await defaults.disconnect();
                }
            });
        });

        it("a new consumer group starts at the end of the stream: earlier events are not delivered", async () => {
            await withTopic(async ({ topic, group }) => {
                const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 20 } });
                const received: string[] = [];
                try {
                    await adapter.connect({ serviceName: "integration-group-start" });
                    await adapter.publish(topic, new Uint8Array(Buffer.from("before-subscribe")));
                    const subscription = await adapter.subscribe(
                        [topic],
                        async (event, ack) => {
                            received.push(Buffer.from(event.payload).toString());
                            await ack();
                        },
                        { group },
                    );
                    await adapter.publish(topic, new Uint8Array(Buffer.from("after-subscribe")));
                    await until(() => received.length >= 1, "delivery of the event published after the subscription");
                    await sleep(150);
                    await subscription.unsubscribe();
                    assert.deepEqual(received, ["after-subscribe"]);
                } finally {
                    await adapter.disconnect();
                }
            });
        });

        it("two subscribers in one consumer group share the stream: every event reaches exactly one of them", async () => {
            await withTopic(async ({ topic, group }) => {
                const first = RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 2 } });
                const second = RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 2 } });
                const receivedBy: Record<string, string[]> = { first: [], second: [] };
                const handlerFor = (who: string) => async (event: RawEvent, ack: () => Promise<void>) => {
                    receivedBy[who]?.push(Buffer.from(event.payload).toString());
                    await ack();
                };
                try {
                    await first.connect({ serviceName: "integration-shared-group-1" });
                    await second.connect({ serviceName: "integration-shared-group-2" });
                    // The second subscribe finds the group already created and must still succeed.
                    const firstSubscription = await first.subscribe([topic], handlerFor("first"), { group });
                    const secondSubscription = await second.subscribe([topic], handlerFor("second"), { group });

                    const payloads = Array.from({ length: 12 }, (_, index) => `event-${index}`);
                    for (const payload of payloads) {
                        await first.publish(topic, new Uint8Array(Buffer.from(payload)));
                    }
                    await until(() => (receivedBy.first?.length ?? 0) + (receivedBy.second?.length ?? 0) >= payloads.length, "delivery of every event");
                    await sleep(150);

                    const all = [...(receivedBy.first ?? []), ...(receivedBy.second ?? [])];
                    assert.deepEqual([...all].sort(), [...payloads].sort(), "no event is lost and none is delivered to both subscribers");
                    await firstSubscription.unsubscribe();
                    await secondSubscription.unsubscribe();
                } finally {
                    await first.disconnect();
                    await second.disconnect();
                }
            });
        });

        for (const [label, settle, staysPending] of [
            ["nack() with no argument", (nack: (requeue?: boolean) => Promise<void>) => nack(), true],
            ["nack(true)", (nack: (requeue?: boolean) => Promise<void>) => nack(true), true],
            ["nack(false)", (nack: (requeue?: boolean) => Promise<void>) => nack(false), false],
        ] as const) {
            it(`${label} ${staysPending ? "leaves the entry pending for redelivery" : "acknowledges the entry so it is never redelivered"}`, async () => {
                await withTopic(async ({ control, topic, streamKey, group }) => {
                    const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 20 } });
                    let deliveries = 0;
                    try {
                        await adapter.connect({ serviceName: "integration-nack" });
                        const subscription = await adapter.subscribe(
                            [topic],
                            async (_event, _ack, nack) => {
                                deliveries += 1;
                                await settle(nack);
                            },
                            { group },
                        );
                        await adapter.publish(topic, new Uint8Array([1]));
                        await until(() => deliveries >= 1, "first delivery");
                        await sleep(200);
                        const pending = await pendingIds(control, streamKey, group);
                        assert.equal(pending.length, staysPending ? 1 : 0, staysPending ? "the entry must stay in the pending list" : "the entry must have left the pending list");
                        assert.equal(deliveries, 1, "an entry is not redelivered before it has been idle for 30 s");
                        await subscription.unsubscribe();
                    } finally {
                        await adapter.disconnect();
                    }
                });
            });
        }

        it("a redelivered event still reports the time it was published, not the time of redelivery", async () => {
            await withTopic(async ({ control, topic, streamKey, group }) => {
                const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 20 } });
                const deliveries: Array<{ publishedAt: Date; receivedAt: number }> = [];
                try {
                    await adapter.connect({ serviceName: "integration-published-at" });
                    const subscription = await adapter.subscribe(
                        [topic],
                        async (event, ack) => {
                            deliveries.push({ publishedAt: event.publishedAt, receivedAt: Date.now() });
                            if (deliveries.length === 1) {
                                throw new Error("fail the first delivery so the entry is redelivered");
                            }
                            await ack();
                        },
                        { group },
                    );
                    const before = Date.now();
                    await adapter.publish(topic, new Uint8Array([1]));
                    const after = Date.now();
                    await until(() => deliveries.length >= 1, "first delivery");

                    await sleep(400);
                    for (const id of await pendingIds(control, streamKey, group)) {
                        await control.call("XCLAIM", streamKey, group, "holding-consumer", "0", id, "IDLE", "31000");
                    }
                    await until(() => deliveries.length >= 2, "redelivery");
                    await subscription.unsubscribe();

                    const redelivery = deliveries[1] as { publishedAt: Date; receivedAt: number };
                    assert.ok(redelivery.publishedAt.getTime() >= before - 1000 && redelivery.publishedAt.getTime() <= after + 1000, "publishedAt is the publish time");
                    assert.ok(redelivery.receivedAt - redelivery.publishedAt.getTime() >= 350, `publishedAt must predate the redelivery by the wait (${redelivery.receivedAt - redelivery.publishedAt.getTime()} ms)`);
                } finally {
                    await adapter.disconnect();
                }
            });
        });

        it("an entry written without an eventType field is reported with an empty event type", async () => {
            await withTopic(async ({ control, topic, streamKey, group }) => {
                const adapter = RedisAdapter({ url, brokerOptions: { blockMs: 20 } });
                const received: RawEvent[] = [];
                try {
                    await adapter.connect({ serviceName: "integration-foreign-entry" });
                    const subscription = await adapter.subscribe(
                        [topic],
                        async (event, ack) => {
                            received.push(event);
                            await ack();
                        },
                        { group },
                    );
                    await control.call("XADD", streamKey, "*", "payload", Buffer.from("foreign").toString("base64"));
                    await until(() => received.length >= 1, "delivery of the foreign entry");
                    await subscription.unsubscribe();
                    assert.equal(received[0]?.eventType, "", "the event type of an entry without one is empty, so the bus matches no route");
                } finally {
                    await adapter.disconnect();
                }
            });
        });

        it("a rejected wildcard subscription leaves no stream or consumer group behind", async () => {
            await withTopic(async ({ control, topic, streamKey, group }) => {
                const adapter = RedisAdapter({ url });
                try {
                    await adapter.connect({ serviceName: "integration-wildcard-leftovers" });
                    await assert.rejects(adapter.subscribe([topic, "orders.*"], async () => undefined, { group }), /wildcard pattern "orders\.\*" is not supported/);
                    assert.equal(await control.exists(streamKey), 0, "the exact topic listed before the wildcard must not have been created");
                } finally {
                    await adapter.disconnect();
                }
            });
        });
    });
});

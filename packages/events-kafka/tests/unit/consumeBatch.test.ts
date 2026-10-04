import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawEvent, RawEventHandler } from "@connectum/events";
import type { EachBatchPayload } from "kafkajs";
import { createBatchConsumer } from "../../src/consumeBatch.ts";

interface FakeMessage {
    offset: string;
    value?: string;
    key?: string;
    headers?: Record<string, string>;
    timestamp?: string;
}

interface Harness {
    readonly commits: { partition: number; offset: string }[];
    readonly resolved: string[];
    readonly paused: { resumed: boolean }[];
    /** Arguments of every `console.error` call made while the batch ran. */
    readonly errorLogs: unknown[][];
    heartbeats: number;
    run: () => Promise<void>;
}

/**
 * Drive the batch callback with a fake KafkaJS payload. `commitFails` makes the nth commit
 * (1-based) reject; `runningWhile` decides what `isRunning()` answers on each call.
 */
function harness(options: {
    messages: FakeMessage[];
    handler: RawEventHandler;
    lastOffset?: string;
    redeliveryDelay?: number;
    commitFails?: number;
    runningWhile?: (call: number) => boolean;
    resumeTimers?: Set<NodeJS.Timeout>;
}): Harness {
    const commits: { partition: number; offset: string }[] = [];
    const resolved: string[] = [];
    const paused: { resumed: boolean }[] = [];
    let isRunningCalls = 0;
    const errorLogs: unknown[][] = [];
    const state: Harness = {
        commits,
        resolved,
        paused,
        errorLogs,
        heartbeats: 0,
        run: async () => {
            const consume = createBatchConsumer({
                handler: options.handler,
                redeliveryDelay: options.redeliveryDelay ?? 0,
                resumeTimers: options.resumeTimers ?? new Set(),
            });
            const messages = options.messages.map((m) => ({
                offset: m.offset,
                key: m.key === undefined ? null : Buffer.from(m.key),
                value: m.value === undefined ? null : Buffer.from(m.value),
                timestamp: m.timestamp ?? "1700000000000",
                headers: Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k, Buffer.from(v)])),
                attributes: 0,
            }));
            const lastMessage = options.messages.at(-1);
            const payload = {
                batch: {
                    topic: "orders.created",
                    partition: 3,
                    messages,
                    lastOffset: () => options.lastOffset ?? lastMessage?.offset ?? "-1",
                },
                resolveOffset: (offset: string) => {
                    resolved.push(offset);
                },
                commitOffsetsIfNecessary: async (offsets?: { topics: { topic: string; partitions: { partition: number; offset: string }[] }[] }) => {
                    if (options.commitFails !== undefined && commits.length + 1 === options.commitFails) {
                        commits.push({ partition: -1, offset: "failed" });
                        throw new Error("commit failed");
                    }
                    for (const t of offsets?.topics ?? []) {
                        assert.equal(t.topic, "orders.created");
                        commits.push(...t.partitions);
                    }
                },
                heartbeat: async () => {
                    state.heartbeats++;
                },
                isRunning: () => {
                    isRunningCalls++;
                    return options.runningWhile === undefined ? true : options.runningWhile(isRunningCalls);
                },
                isStale: () => false,
                pause: () => {
                    const entry = { resumed: false };
                    paused.push(entry);
                    return () => {
                        entry.resumed = true;
                    };
                },
                uncommittedOffsets: () => ({ topics: [] }),
            } as unknown as EachBatchPayload;
            const originalError = console.error;
            console.error = (...args: unknown[]) => {
                errorLogs.push(args);
            };
            try {
                await consume(payload);
            } finally {
                console.error = originalError;
            }
        },
    };
    return state;
}

const three: FakeMessage[] = [
    { offset: "10", value: "a" },
    { offset: "11", value: "b" },
    { offset: "12", value: "c" },
];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createBatchConsumer", () => {
    it("an empty batch calls nothing", async () => {
        let called = 0;
        const h = harness({
            messages: [],
            handler: async () => {
                called++;
            },
        });
        await h.run();
        assert.equal(called, 0);
        assert.deepEqual(h.commits, []);
        assert.equal(h.heartbeats, 0);
    });

    it("commits offset + 1 for every acked message and keeps the consumer alive between them", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            lastOffset: "12",
            handler: async (event, ack) => {
                seen.push(Buffer.from(event.payload).toString());
                await ack();
            },
        });
        await h.run();
        assert.deepEqual(seen, ["a", "b", "c"]);
        assert.deepEqual(h.commits, [
            { partition: 3, offset: "11" },
            { partition: 3, offset: "12" },
            { partition: 3, offset: "13" },
        ]);
        assert.deepEqual(h.resolved, ["10", "11", "12"]);
        assert.equal(h.heartbeats, 3);
    });

    it("the last message commits past trailing control records of the batch", async () => {
        const h = harness({
            messages: [{ offset: "10", value: "a" }, { offset: "11", value: "b" }],
            lastOffset: "15",
            handler: async (_event, ack) => {
                await ack();
            },
        });
        await h.run();
        assert.deepEqual(h.commits, [
            { partition: 3, offset: "11" },
            { partition: 3, offset: "16" },
        ]);
    });

    it("computes the next offset without losing precision beyond 2^53", async () => {
        const h = harness({
            messages: [{ offset: "9007199254740993", value: "a" }],
            handler: async (_event, ack) => {
                await ack();
            },
        });
        await h.run();
        assert.deepEqual(h.commits, [{ partition: 3, offset: "9007199254740994" }]);
    });

    it("a throwing handler ends the batch: earlier acks stay committed, later messages are not delivered", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            handler: async (event, ack) => {
                const value = Buffer.from(event.payload).toString();
                seen.push(value);
                if (value === "b") throw new Error("boom");
                await ack();
            },
        });
        await h.run();
        assert.deepEqual(seen, ["a", "b"]);
        assert.deepEqual(h.commits, [{ partition: 3, offset: "11" }]);
        assert.deepEqual(h.resolved, ["10"]);
    });

    it("a handler error is reported with topic, partition and offset instead of being swallowed", async () => {
        const failure = new Error("boom");
        const h = harness({
            messages: three,
            handler: async (event, ack) => {
                if (Buffer.from(event.payload).toString() === "b") throw failure;
                await ack();
            },
        });
        await h.run();
        assert.equal(h.errorLogs.length, 1);
        assert.deepEqual(h.errorLogs[0], ["[KafkaAdapter] handler error for orders.created[3]@11:", failure]);
    });

    it("settled messages produce no error log", async () => {
        const h = harness({
            messages: three,
            handler: async (_event, ack) => {
                await ack();
            },
        });
        await h.run();
        assert.deepEqual(h.errorLogs, []);
    });

    it("ack before a throw still counts: the committed message is not redelivered", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            handler: async (event, ack) => {
                seen.push(Buffer.from(event.payload).toString());
                await ack();
                if (seen.length === 1) throw new Error("late failure");
            },
        });
        await h.run();
        assert.deepEqual(seen, ["a", "b", "c"], "a throw after a successful ack must not stop the batch");
        assert.equal(h.commits.length, 3);
    });

    it("nack(true) ends the batch without committing; nack(false) commits and continues", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            handler: async (event, _ack, nack) => {
                const value = Buffer.from(event.payload).toString();
                seen.push(value);
                if (value === "a") {
                    await nack(false);
                    return;
                }
                await nack(true);
            },
        });
        await h.run();
        assert.deepEqual(seen, ["a", "b"]);
        assert.deepEqual(h.commits, [{ partition: 3, offset: "11" }]);
    });

    it("nack() without arguments requeues", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            handler: async (event, _ack, nack) => {
                seen.push(Buffer.from(event.payload).toString());
                await nack();
            },
        });
        await h.run();
        assert.deepEqual(seen, ["a"]);
        assert.deepEqual(h.commits, []);
    });

    it("returning without settling leaves the message and the rest of the batch uncommitted", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            handler: async (event, ack) => {
                const value = Buffer.from(event.payload).toString();
                seen.push(value);
                if (value === "a") await ack();
            },
        });
        await h.run();
        assert.deepEqual(seen, ["a", "b"]);
        assert.deepEqual(h.commits, [{ partition: 3, offset: "11" }]);
    });

    it("the first settlement wins: repeated ack commits once, a requeue followed by ack stays a requeue, ack followed by nack(true) stays committed", async () => {
        const first = harness({
            messages: [{ offset: "10", value: "a" }],
            handler: async (_event, ack) => {
                await ack();
                await ack();
            },
        });
        await first.run();
        assert.equal(first.commits.length, 1, "duplicate ack must not commit twice");

        const requeueThenAck = harness({
            messages: three,
            handler: async (_event, ack, nack) => {
                await nack(true);
                await ack();
            },
        });
        await requeueThenAck.run();
        assert.deepEqual(requeueThenAck.commits, []);

        const ackThenRequeue = harness({
            messages: [{ offset: "10", value: "a" }],
            handler: async (_event, ack, nack) => {
                await ack();
                await nack(true);
            },
        });
        await ackThenRequeue.run();
        assert.equal(ackThenRequeue.commits.length, 1);
    });

    it("an ack that arrives after the handler turn is ignored", async () => {
        let lateAck: (() => Promise<void>) | undefined;
        const h = harness({
            messages: three,
            handler: async (_event, ack) => {
                lateAck = ack;
            },
        });
        await h.run();
        await lateAck?.();
        assert.deepEqual(h.commits, []);
        assert.deepEqual(h.resolved, []);
    });

    it("an ack that the handler does not await is still committed before the batch moves on", async () => {
        const h = harness({
            messages: [{ offset: "10", value: "a" }],
            handler: async (_event, ack) => {
                void ack();
            },
        });
        await h.run();
        assert.deepEqual(h.commits, [{ partition: 3, offset: "11" }]);
    });

    it("a failed commit is rethrown to KafkaJS and stops the batch", async () => {
        const seen: string[] = [];
        const h = harness({
            messages: three,
            commitFails: 2,
            handler: async (event, ack) => {
                seen.push(Buffer.from(event.payload).toString());
                await ack();
            },
        });
        await assert.rejects(() => h.run(), { message: "commit failed" });
        assert.deepEqual(seen, ["a", "b"]);
        assert.deepEqual(h.resolved, ["10"], "a message whose commit failed is not resolved");
    });

    it("a failed commit surfaces even when the handler swallows the ack error or does not wait for it", async () => {
        const swallowed = harness({
            messages: three,
            commitFails: 1,
            handler: async (_event, ack) => {
                try {
                    await ack();
                } catch {
                    // The handler hides the failure; the adapter must not.
                }
            },
        });
        await assert.rejects(() => swallowed.run(), { message: "commit failed" });

        const detached = harness({
            messages: three,
            commitFails: 1,
            handler: async (_event, ack) => {
                ack().catch(() => undefined);
            },
        });
        await assert.rejects(() => detached.run(), { message: "commit failed" });
    });

    it("stops delivering as soon as the consumer is no longer running", async () => {
        const never = harness({
            messages: three,
            runningWhile: () => false,
            handler: async (_event, ack) => {
                await ack();
            },
        });
        await never.run();
        assert.deepEqual(never.commits, []);

        const seen: string[] = [];
        const afterFirst = harness({
            messages: three,
            runningWhile: (call) => call === 1,
            handler: async (event, ack) => {
                seen.push(Buffer.from(event.payload).toString());
                await ack();
            },
        });
        await afterFirst.run();
        assert.deepEqual(seen, ["a"]);
        assert.deepEqual(afterFirst.commits, [{ partition: 3, offset: "11" }]);
    });

    it("builds the raw event from headers, key, value and timestamp, and hides internal headers", async () => {
        const events: RawEvent[] = [];
        const h = harness({
            messages: [
                { offset: "10", value: "payload", key: "k", headers: { "x-event-id": "evt-1", "x-published-at": "2024-01-02T03:04:05.000Z", tenant: "acme" } },
                { offset: "11", key: "fallback-key", timestamp: "1700000000000" },
            ],
            handler: async (event, ack) => {
                events.push(event);
                await ack();
            },
        });
        await h.run();
        const [first, second] = events;
        assert.ok(first && second);
        assert.equal(first.eventId, "evt-1");
        assert.equal(first.eventType, "orders.created");
        assert.equal(Buffer.from(first.payload).toString(), "payload");
        assert.equal(first.publishedAt.toISOString(), "2024-01-02T03:04:05.000Z");
        assert.equal(first.attempt, 1);
        assert.deepEqual([...first.metadata], [["tenant", "acme"]]);
        assert.equal(second.eventId, "fallback-key", "without the id header the message key identifies the event");
        assert.equal(second.payload.length, 0, "a tombstone has an empty payload");
        assert.equal(second.publishedAt.getTime(), 1700000000000, "without the timestamp header the broker timestamp is used");
    });

    it("pauses the partition for the redelivery delay when a message stays uncommitted, then resumes it", async () => {
        const timers = new Set<NodeJS.Timeout>();
        const h = harness({
            messages: three,
            redeliveryDelay: 40,
            resumeTimers: timers,
            handler: async () => {
                throw new Error("boom");
            },
        });
        await h.run();
        assert.equal(h.paused.length, 1);
        assert.equal(h.paused[0]?.resumed, false);
        assert.equal(timers.size, 1);
        await sleep(120);
        assert.equal(h.paused[0]?.resumed, true);
        assert.equal(timers.size, 0, "a fired timer removes itself");
    });

    it("does not pause when the delay is zero or the message was committed", async () => {
        const noDelay = harness({
            messages: three,
            handler: async () => {
                throw new Error("boom");
            },
        });
        await noDelay.run();
        assert.equal(noDelay.paused.length, 0);

        const committed = harness({
            messages: three,
            redeliveryDelay: 40,
            handler: async (_event, ack) => {
                await ack();
            },
        });
        await committed.run();
        assert.equal(committed.paused.length, 0);
    });

    it("a cancelled resume timer never resumes the partition", async () => {
        const timers = new Set<NodeJS.Timeout>();
        const h = harness({
            messages: three,
            redeliveryDelay: 40,
            resumeTimers: timers,
            handler: async () => {
                throw new Error("boom");
            },
        });
        await h.run();
        for (const timer of timers) clearTimeout(timer);
        await sleep(120);
        assert.equal(h.paused[0]?.resumed, false);
    });
});

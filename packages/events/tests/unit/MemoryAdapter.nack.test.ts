/**
 * `nack` of the in-memory adapter: `nack(true)` returns the event to the same subscription as a
 * later macrotask with a raised `attempt`; `nack(false)` discards it; a redelivery still waiting
 * when the subscription goes away is dropped, so a stopping bus cannot loop nack, redeliver, nack.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import type { RawEvent } from "../../src/types.ts";

const payload = new Uint8Array([1]);

/**
 * Wait until something that must happen has happened. Never throws: on a timeout the assertion after
 * it reports the actual values. A fixed sleep is used only where nothing is expected to happen.
 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
        await sleep(5);
    }
}

describe("MemoryAdapter nack", () => {
    it("nack(true) redelivers to the same subscription with a raised attempt, and ack ends it", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: number[] = [];
        const ids = new Set<string>();
        await adapter.subscribe(["t"], async (event, ack, nack) => {
            attempts.push(event.attempt);
            ids.add(event.eventId);
            if (event.attempt < 3) {
                await nack(true);
            } else {
                await ack();
            }
        });

        await adapter.publish("t", payload);
        await until(() => attempts.length >= 3);
        await sleep(30); // a wrongly extra redelivery would show up now

        assert.deepEqual(attempts, [1, 2, 3]);
        assert.equal(ids.size, 1, "a redelivery is the same event, not a new one");
    });

    it("nack() without an argument requeues", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: number[] = [];
        await adapter.subscribe(["t"], async (event, _ack, nack) => {
            attempts.push(event.attempt);
            if (event.attempt === 1) await nack();
        });

        await adapter.publish("t", payload);
        await until(() => attempts.length >= 2);
        await sleep(30);

        assert.deepEqual(attempts, [1, 2]);
    });

    it("nack(false) discards the event", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: number[] = [];
        await adapter.subscribe(["t"], async (event, _ack, nack) => {
            attempts.push(event.attempt);
            await nack(false);
        });

        await adapter.publish("t", payload);
        await sleep(50);

        assert.deepEqual(attempts, [1]);
    });

    it("the redelivery goes to the nacking subscription only, not to other subscribers", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const first: number[] = [];
        const second: number[] = [];
        await adapter.subscribe(["t"], async (event, _ack, nack) => {
            first.push(event.attempt);
            if (event.attempt === 1) await nack(true);
        });
        await adapter.subscribe(["t"], async (event) => {
            second.push(event.attempt);
        });

        await adapter.publish("t", payload);
        await until(() => first.length >= 2);
        await sleep(30);

        assert.deepEqual(first, [1, 2]);
        assert.deepEqual(second, [1]);
    });

    it("the redelivery is a later task: publish() returns before it runs", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: number[] = [];
        await adapter.subscribe(["t"], async (event, _ack, nack) => {
            attempts.push(event.attempt);
            if (event.attempt === 1) await nack(true);
        });

        await adapter.publish("t", payload);
        assert.deepEqual(attempts, [1], "the second attempt must not have run inside publish()");
        await until(() => attempts.length >= 2);
        assert.deepEqual(attempts, [1, 2]);
    });

    it("a handler that always nacks yields to timers between attempts", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        let attempts = 0;
        await adapter.subscribe(["t"], async (_event, _ack, nack) => {
            attempts++;
            await nack(true);
        });
        await adapter.publish("t", payload);

        let timerRan = false;
        setTimeout(() => {
            timerRan = true;
        }, 20);
        await until(() => timerRan && attempts >= 2);

        assert.ok(timerRan, "a 20 ms timer must run while the handler keeps nacking");
        assert.ok(attempts >= 2);
        await adapter.disconnect();
    });

    it("the pending redelivery keeps the process alive until it runs, so it is not lost at exit", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const original = globalThis.setTimeout;
        const created: ReturnType<typeof setTimeout>[] = [];
        let attempts = 0;
        await adapter.subscribe(["t"], async (_event, ack, nack) => {
            attempts++;
            if (attempts === 1) {
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    const timer = original(...args);
                    created.push(timer);
                    return timer;
                }) as typeof setTimeout;
                try {
                    await nack(true);
                } finally {
                    globalThis.setTimeout = original;
                }
            } else {
                await ack();
            }
        });

        await adapter.publish("t", payload);

        assert.equal(created.length, 1, "nack(true) schedules exactly one timer");
        assert.equal(created[0]?.hasRef(), true, "an unref'd timer lets a process with nothing else pending exit before the redelivery");
        await until(() => attempts >= 2);
        assert.equal(attempts, 2);
    });

    it("unsubscribe() drops a redelivery that is still waiting", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: number[] = [];
        const subscription = await adapter.subscribe(["t"], async (event, _ack, nack) => {
            attempts.push(event.attempt);
            await nack(true);
        });

        await adapter.publish("t", payload);
        await subscription.unsubscribe();
        await sleep(50);

        assert.deepEqual(attempts, [1]);
    });

    it("a nack(true) after unsubscribe() is not redelivered (no second hop while draining)", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: number[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const subscription = await adapter.subscribe(["t"], async (event, _ack, nack) => {
            attempts.push(event.attempt);
            await gate;
            await nack(true);
        });

        const publishing = adapter.publish("t", payload);
        await subscription.unsubscribe();
        release();
        await publishing;
        await sleep(50);

        assert.deepEqual(attempts, [1]);
    });

    it("disconnect() drops redeliveries of every subscription", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const attempts: RawEvent["attempt"][] = [];
        await adapter.subscribe(["t"], async (event, _ack, nack) => {
            attempts.push(event.attempt);
            await nack(true);
        });

        await adapter.publish("t", payload);
        await adapter.disconnect();
        await sleep(50);

        assert.deepEqual(attempts, [1]);
    });

    it("a handler that throws on a redelivery does not raise an unhandled rejection", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            await adapter.subscribe(["t"], async (event, _ack, nack) => {
                if (event.attempt === 1) {
                    await nack(true);
                    return;
                }
                throw new Error("redelivery failed");
            });

            await adapter.publish("t", payload);
            await sleep(50);

            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

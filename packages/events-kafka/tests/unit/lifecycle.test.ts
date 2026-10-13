import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchLifecycle, trackConsumer } from "../../src/lifecycle.ts";
import type { KafkaLifecycleEvent } from "../../src/types.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const boom = new Error("crashed");

describe("dispatchLifecycle", () => {
    it("does nothing without a callback", () => {
        assert.doesNotThrow(() => dispatchLifecycle(undefined, { type: "connected", reconnected: false }));
    });

    it("isolates a synchronous throw and reports it once as lifecycle-error", () => {
        const seen: KafkaLifecycleEvent[] = [];
        dispatchLifecycle(
            {
                onLifecycle: (e) => {
                    seen.push(e);
                    if (e.type !== "lifecycle-error") {
                        throw new Error("boom");
                    }
                },
            },
            { type: "connected", reconnected: false },
        );
        assert.deepEqual(
            seen.map((e) => e.type),
            ["connected", "lifecycle-error"],
        );
    });

    it("isolates a rejected promise and drops a failure while handling lifecycle-error", async () => {
        let calls = 0;
        dispatchLifecycle(
            {
                onLifecycle: async () => {
                    calls += 1;
                    throw new Error("always");
                },
            },
            { type: "connected", reconnected: false },
        );
        await tick();
        await tick();
        assert.equal(calls, 2, "the event and one lifecycle-error, no more");
    });
});

describe("trackConsumer", () => {
    function tracked() {
        const events: KafkaLifecycleEvent[] = [];
        const tracker = trackConsumer({ onLifecycle: (e) => void events.push(e) });
        return { events, tracker };
    }

    it("reports nothing for group joins that follow no crash: the first join, rebalances, the restart topic discovery causes", () => {
        const { events, tracker } = tracked();
        tracker.onGroupJoin({ groupId: "g" });
        tracker.onGroupJoin({ groupId: "g" });
        assert.deepEqual(events, []);
    });

    it("a crash is consumer-lost and the next group join is consumer-restored with attempt 1", () => {
        const { events, tracker } = tracked();
        tracker.onCrash({ error: boom, groupId: "g", restart: true });
        tracker.onGroupJoin({ groupId: "g" });
        assert.deepEqual(events, [
            { type: "consumer-lost", groupId: "g", error: boom, willRestore: true },
            { type: "consumer-restored", groupId: "g", attempt: 1 },
        ]);
    });

    it("crashes before the consumer came back are consumer-restore-failed with a counted attempt, and the restore carries the next number", () => {
        const { events, tracker } = tracked();
        tracker.onCrash({ error: boom, groupId: "g", restart: true });
        tracker.onCrash({ error: boom, groupId: "g", restart: true });
        tracker.onCrash({ error: boom, groupId: "g", restart: false });
        tracker.onGroupJoin({ groupId: "g" });
        assert.deepEqual(
            events.map((e) => e.type),
            ["consumer-lost", "consumer-restore-failed", "consumer-restore-failed", "consumer-restored"],
        );
        assert.deepEqual(
            events.filter((e) => e.type === "consumer-restore-failed").map((e) => (e as Extract<KafkaLifecycleEvent, { type: "consumer-restore-failed" }>).attempt),
            [1, 2],
        );
        assert.equal((events[2] as Extract<KafkaLifecycleEvent, { type: "consumer-restore-failed" }>).willRetry, false);
        assert.equal((events[3] as Extract<KafkaLifecycleEvent, { type: "consumer-restored" }>).attempt, 3);
    });

    it("a second loss after a recovery starts again as consumer-lost with attempts from 1", () => {
        const { events, tracker } = tracked();
        tracker.onCrash({ error: boom, groupId: "g", restart: true });
        tracker.onCrash({ error: boom, groupId: "g", restart: true });
        tracker.onGroupJoin({ groupId: "g" });
        tracker.onCrash({ error: boom, groupId: "g", restart: true });
        tracker.onGroupJoin({ groupId: "g" });
        assert.deepEqual(
            events.map((e) => e.type),
            ["consumer-lost", "consumer-restore-failed", "consumer-restored", "consumer-lost", "consumer-restored"],
        );
        assert.equal((events[4] as Extract<KafkaLifecycleEvent, { type: "consumer-restored" }>).attempt, 1);
    });
});

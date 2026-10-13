import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchLifecycle } from "../../src/lifecycle.ts";
import type { NatsLifecycleEvent } from "../../src/types.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("dispatchLifecycle", () => {
    it("does nothing without a callback", () => {
        assert.doesNotThrow(() => dispatchLifecycle(undefined, { type: "reconnecting", attempt: 1 }));
        assert.doesNotThrow(() => dispatchLifecycle({}, { type: "reconnecting", attempt: 1 }));
    });

    it("delivers the event as given", () => {
        const seen: NatsLifecycleEvent[] = [];
        dispatchLifecycle({ onLifecycle: (e) => void seen.push(e) }, { type: "connected", reconnected: true, server: "s:4222" });
        assert.deepEqual(seen, [{ type: "connected", reconnected: true, server: "s:4222" }]);
    });

    it("isolates a synchronous throw and reports it once as lifecycle-error", () => {
        const seen: NatsLifecycleEvent[] = [];
        dispatchLifecycle(
            {
                onLifecycle: (e) => {
                    seen.push(e);
                    if (e.type !== "lifecycle-error") {
                        throw new Error("boom");
                    }
                },
            },
            { type: "disconnected", server: "s" },
        );
        assert.deepEqual(
            seen.map((e) => e.type),
            ["disconnected", "lifecycle-error"],
        );
        const report = seen[1] as Extract<NatsLifecycleEvent, { type: "lifecycle-error" }>;
        assert.equal(report.event, "disconnected");
        assert.equal(report.callback, "onLifecycle");
        assert.equal(report.error.message, "boom");
    });

    it("isolates a rejected promise without awaiting it", async () => {
        const seen: string[] = [];
        dispatchLifecycle(
            {
                onLifecycle: async (e) => {
                    seen.push(e.type);
                    throw new Error("late");
                },
            },
            { type: "reconnecting", attempt: 1 },
        );
        assert.deepEqual(seen, ["reconnecting"], "the callback ran synchronously");
        await tick();
        assert.deepEqual(seen, ["reconnecting", "lifecycle-error"]);
    });

    it("drops a failure while handling lifecycle-error, so the report path cannot recurse", async () => {
        let calls = 0;
        dispatchLifecycle(
            {
                onLifecycle: async () => {
                    calls += 1;
                    throw new Error("always");
                },
            },
            { type: "reconnecting", attempt: 1 },
        );
        await tick();
        await tick();
        assert.equal(calls, 2, "the event and one lifecycle-error, no more");
    });

    it("wraps a thrown non-Error value", () => {
        const seen: NatsLifecycleEvent[] = [];
        dispatchLifecycle(
            {
                onLifecycle: (e) => {
                    seen.push(e);
                    if (e.type !== "lifecycle-error") {
                        throw "text";
                    }
                },
            },
            { type: "reconnecting", attempt: 2 },
        );
        const report = seen[1] as Extract<NatsLifecycleEvent, { type: "lifecycle-error" }>;
        assert.ok(report.error instanceof Error);
        assert.equal(report.error.message, "text");
    });
});

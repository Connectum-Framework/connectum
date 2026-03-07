import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventBus } from "../../src/EventBus.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";

describe("EventBus lifecycle", () => {
    it("starts and stops with MemoryAdapter", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        await bus.start();
        await bus.stop();
    });

    it("throws on double start", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        await bus.start();
        await assert.rejects(() => bus.start(), { message: /already started/ });
        await bus.stop();
    });

    it("stop is safe to call when not started", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        // Should not throw
        await bus.stop();
    });
});

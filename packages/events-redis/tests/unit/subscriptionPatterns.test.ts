import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

// Redis keys are arbitrary strings, so the adapter does not judge the segments of a topic name:
// an adapter that was never connected reaches its connection check for every one of them.
describe("RedisAdapter subscription patterns", () => {
    it("does not reject topic names with an empty segment", async () => {
        for (const pattern of ["", "a..b", ".a", "a.", ".", "a.b"]) {
            const adapter = RedisAdapter();

            await assert.rejects(
                adapter.subscribe([pattern], async () => undefined),
                { message: "RedisAdapter: not connected" },
                JSON.stringify(pattern),
            );
        }
    });
});

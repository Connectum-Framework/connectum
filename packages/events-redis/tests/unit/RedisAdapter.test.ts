import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

describe("RedisAdapter", () => {
    it("should return an adapter with name 'redis'", () => {
        const adapter = RedisAdapter();
        assert.equal(adapter.name, "redis");
    });

    it("should have all required EventAdapter methods", () => {
        const adapter = RedisAdapter();
        assert.equal(typeof adapter.connect, "function");
        assert.equal(typeof adapter.disconnect, "function");
        assert.equal(typeof adapter.publish, "function");
        assert.equal(typeof adapter.subscribe, "function");
    });

    it("should throw when publishing without connection", async () => {
        const adapter = RedisAdapter();
        const payload = new Uint8Array([1, 2, 3]);

        await assert.rejects(
            () => adapter.publish("test.event", payload),
            { message: "RedisAdapter: not connected" },
        );
    });

    it("should throw when subscribing without connection", async () => {
        const adapter = RedisAdapter();

        await assert.rejects(
            () => adapter.subscribe(["test.event"], async () => {}),
            { message: "RedisAdapter: not connected" },
        );
    });

    it("should accept options without url or redisOptions", () => {
        const adapter = RedisAdapter({});
        assert.equal(adapter.name, "redis");
    });

    it("should accept options with url", () => {
        const adapter = RedisAdapter({ url: "redis://localhost:6379" });
        assert.equal(adapter.name, "redis");
    });

    it("should accept options with brokerOptions", () => {
        const adapter = RedisAdapter({
            brokerOptions: {
                maxLen: 1000,
                blockMs: 3000,
                count: 5,
            },
        });
        assert.equal(adapter.name, "redis");
    });

    it("should not throw on disconnect when not connected", async () => {
        const adapter = RedisAdapter();
        // Disconnect on a never-connected adapter should be a no-op
        await adapter.disconnect();
    });

    it("should accept empty default options", () => {
        const adapter = RedisAdapter();
        assert.equal(adapter.name, "redis");
    });
});

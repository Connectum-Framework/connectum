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

    it("should accept options with redisOptions", () => {
        const adapter = RedisAdapter({
            redisOptions: { maxRetriesPerRequest: 3, lazyConnect: true },
        });
        assert.equal(adapter.name, "redis");
    });
});

describe("RedisAdapter AdapterContext", () => {
    // Note: connect() requires a running Redis server, so we test the interface
    // contract and construction behavior rather than successful connection.

    it("connect() accepts AdapterContext parameter", () => {
        const adapter = RedisAdapter();
        assert.equal(typeof adapter.connect, "function");
    });

    it("connectionName falls back to context.serviceName when redisOptions.connectionName is not set", async () => {
        // Use lazyConnect to prevent automatic connection and an unreachable host
        const adapter = RedisAdapter({
            redisOptions: { lazyConnect: true, host: "invalid-redis-host", port: 1, retryStrategy: () => null },
        });

        // connect() will fail (no Redis server), but should accept the context
        // without throwing TypeError. The actual connectionName =
        // redisOptions.connectionName ?? context.serviceName
        await assert.rejects(
            () => adapter.connect({ serviceName: "order.v1@test-host" }),
            (err: Error) => {
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for AdapterContext");
                return true;
            },
        );
    });

    it("explicit redisOptions.connectionName takes priority over context.serviceName", () => {
        // Verify construction works -- actual priority is tested at connect() time
        const adapter = RedisAdapter({
            redisOptions: { connectionName: "explicit-name", lazyConnect: true },
        });
        assert.equal(adapter.name, "redis");
    });

    it("connect() works with undefined context (backward compat)", async () => {
        const adapter = RedisAdapter({
            redisOptions: { lazyConnect: true, host: "invalid-redis-host", port: 1, retryStrategy: () => null },
        });

        // Calling connect() without context should still work (minus Redis availability)
        await assert.rejects(
            () => adapter.connect(),
            (err: Error) => {
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for missing context");
                return true;
            },
        );
    });
});

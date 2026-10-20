import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

describe("RedisAdapter", () => {
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

    it("should not throw on disconnect when not connected", async () => {
        const adapter = RedisAdapter();
        // Disconnect on a never-connected adapter should be a no-op
        await adapter.disconnect();
    });

    it("rejects native RESP3 reply mapping on the RESP2 wire protocol when the adapter is created", () => {
        assert.throws(() => RedisAdapter({ redisOptions: { replyMapping: "resp3" } }), TypeError);
    });
});

describe("RedisAdapter failed connect", () => {
    // An unreachable host: the client gives up at once (no retries), so connect() rejects.
    const unreachable = { lazyConnect: true, host: "127.0.0.1", port: 1, retryStrategy: () => null } as const;

    it("rejects with the connection error and leaves the adapter free to connect again", async () => {
        const adapter = RedisAdapter({ redisOptions: unreachable });

        const firstError = await adapter.connect({ serviceName: "order.v1@test-host" }).then(
            () => assert.fail("connect() must reject when the broker is unreachable"),
            (error: Error) => error,
        );
        assert.doesNotMatch(firstError.message, /already connected/);

        // A failed connect() must not leave a half-open client behind: the retry is a fresh attempt
        // that fails for the same reason, not an "already connected" refusal.
        const secondError = await adapter.connect().then(
            () => assert.fail("the second connect() must also reject"),
            (error: Error) => error,
        );
        assert.doesNotMatch(secondError.message, /already connected/);
        assert.equal(secondError.message, firstError.message);

        await adapter.disconnect();
    });
});

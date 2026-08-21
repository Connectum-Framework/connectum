import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RedisReplyContext } from "../../src/RedisProtocol.ts";
import {
    normalizeXAutoClaimReply,
    normalizeXPendingReply,
    normalizeXReadGroupReply,
    RedisReplyShapeError,
    redisReplyContext,
    resolveRedisOptions,
} from "../../src/RedisProtocol.ts";

const RESP2: RedisReplyContext = { protocol: 2, replyMapping: "legacy" };
const RESP3_LEGACY: RedisReplyContext = { protocol: 3, replyMapping: "legacy" };
const RESP3_NATIVE: RedisReplyContext = { protocol: 3, replyMapping: "resp3" };

describe("Redis protocol configuration", () => {
    it("defaults to RESP2 without mutating caller options", () => {
        const input = { lazyConnect: true } as const;
        const resolved = resolveRedisOptions(input);

        assert.equal(resolved.protocol, 2);
        assert.equal(resolved.lazyConnect, true);
        assert.deepEqual(input, { lazyConnect: true });
        assert.deepEqual(redisReplyContext(resolved), RESP2);
    });

    it("honors RESP3 native mapping", () => {
        const resolved = resolveRedisOptions({ protocol: 3, replyMapping: "resp3" });

        assert.deepEqual(redisReplyContext(resolved), RESP3_NATIVE);
    });

    it("injects a service connection name only when the caller omitted one", () => {
        assert.equal(resolveRedisOptions({ protocol: 3 }, "orders.v1").connectionName, "orders.v1");
        assert.equal(resolveRedisOptions({ connectionName: "explicit" }, "orders.v1").connectionName, "explicit");
    });

    it("rejects native RESP3 mapping on the RESP2 wire protocol", () => {
        assert.throws(
            () => resolveRedisOptions({ protocol: 2, replyMapping: "resp3" }),
            /replyMapping "resp3" requires redisOptions\.protocol 3/,
        );
    });
});

describe("Redis Streams reply normalization", () => {
    const entries = [["1-0", ["eventId", "e1", "payload", "cA=="]]];

    it("normalizes RESP2 nested XREADGROUP maps", () => {
        assert.deepEqual(normalizeXReadGroupReply([["s1", entries]], RESP2), [["s1", entries]]);
    });

    it("normalizes RESP3 legacy flat XREADGROUP maps with multiple streams", () => {
        assert.deepEqual(normalizeXReadGroupReply(["s1", entries, "s2", entries], RESP3_LEGACY), [
            ["s1", entries],
            ["s2", entries],
        ]);
    });

    it("normalizes RESP3 native XREADGROUP maps", () => {
        assert.deepEqual(normalizeXReadGroupReply({ s1: entries, s2: entries }, RESP3_NATIVE), [
            ["s1", entries],
            ["s2", entries],
        ]);
    });

    it("normalizes object-shaped native stream fields", () => {
        assert.deepEqual(normalizeXReadGroupReply({ s1: [["1-0", { eventId: "e1", payload: "cA==" }]] }, RESP3_NATIVE), [
            ["s1", entries],
        ]);
    });

    it("normalizes Redis 6.2 and newer XAUTOCLAIM variants", () => {
        assert.deepEqual(normalizeXAutoClaimReply(["0-0", entries], RESP3_LEGACY), ["0-0", entries, []]);
        assert.deepEqual(normalizeXAutoClaimReply(["0-0", entries, ["deleted-0"]], RESP3_NATIVE), [
            "0-0",
            entries,
            ["deleted-0"],
        ]);
    });

    it("normalizes detailed XPENDING delivery counts", () => {
        assert.deepEqual(normalizeXPendingReply([["1-0", "consumer-1", "42", 3]], RESP3_NATIVE), [
            ["1-0", "consumer-1", 42, 3],
        ]);
    });

    for (const [command, run] of [
        ["XREADGROUP", () => normalizeXReadGroupReply(["s1"], RESP3_LEGACY)],
        ["XAUTOCLAIM", () => normalizeXAutoClaimReply(["0-0"], RESP3_NATIVE)],
        ["XPENDING", () => normalizeXPendingReply({ bad: "shape" }, RESP2)],
    ] as const) {
        it(`reports ${command} and protocol context for malformed replies`, () => {
            assert.throws(run, (error: unknown) => {
                assert.ok(error instanceof RedisReplyShapeError);
                assert.equal(error.command, command);
                assert.match(error.message, new RegExp(`${command} reply for RESP`));
                return true;
            });
        });
    }
});

/**
 * The cache key shared by the server and the standalone catalog client: one entry per (typeName, endpoint) pair.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { remoteTransportCacheKey } from "../../src/catalogDispatcher.ts";

describe("remoteTransportCacheKey", () => {
    it("is the same for the same (typeName, endpoint) pair", () => {
        assert.strictEqual(remoteTransportCacheKey("orders.v1.OrdersService", "eu"), remoteTransportCacheKey("orders.v1.OrdersService", "eu"));
    });

    it("differs when only the endpoint differs, or only the typeName differs", () => {
        assert.notStrictEqual(remoteTransportCacheKey("orders.v1.OrdersService", "eu"), remoteTransportCacheKey("orders.v1.OrdersService", "us"));
        assert.notStrictEqual(remoteTransportCacheKey("orders.v1.OrdersService", "eu"), remoteTransportCacheKey("orders.v1.PaymentsService", "eu"));
    });

    it("does not let a part of the endpoint pass for part of the typeName", () => {
        assert.notStrictEqual(remoteTransportCacheKey("a", "b c"), remoteTransportCacheKey("a b", "c"));
    });

    it("treats an absent endpoint and an empty one as the same route", () => {
        assert.strictEqual(remoteTransportCacheKey("orders.v1.OrdersService", undefined), remoteTransportCacheKey("orders.v1.OrdersService", ""));
    });
});

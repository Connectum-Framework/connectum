import assert from "node:assert/strict";
import { hostname } from "node:os";
import { describe, it } from "node:test";
import { deriveServiceName } from "../../src/EventBus.ts";

describe("deriveServiceName", () => {
    it("returns undefined for empty array", () => {
        assert.equal(deriveServiceName([]), undefined);
    });

    it("extracts package name from single service", () => {
        const result = deriveServiceName(["order.v1.OrderEventService"]);
        assert.equal(result, `order.v1@${hostname()}`);
    });

    it("extracts package names from multiple services in different packages", () => {
        const result = deriveServiceName([
            "order.v1.OrderEventService",
            "payment.v1.PaymentEventService",
        ]);
        assert.equal(result, `order.v1/payment.v1@${hostname()}`);
    });

    it("deduplicates services from the same package", () => {
        const result = deriveServiceName([
            "order.v1.OrderCreatedHandler",
            "order.v1.OrderUpdatedHandler",
        ]);
        // Both services are in the same package "order.v1", should deduplicate
        assert.equal(result, `order.v1@${hostname()}`);
    });

    it("handles mixed duplicates and unique packages", () => {
        const result = deriveServiceName([
            "order.v1.OrderEventService",
            "order.v1.OrderAuditService",
            "payment.v1.PaymentEventService",
        ]);
        assert.equal(result, `order.v1/payment.v1@${hostname()}`);
    });

    it("handles single-segment type name (no dots)", () => {
        // When typeName has no dots, extractPackageName returns the whole string
        const result = deriveServiceName(["SimpleService"]);
        assert.equal(result, `SimpleService@${hostname()}`);
    });

    it("appends current hostname", () => {
        const result = deriveServiceName(["test.v1.TestService"]);
        assert.ok(result);
        assert.ok(result.endsWith(`@${hostname()}`), `Expected result to end with @${hostname()}, got: ${result}`);
    });

    it("preserves insertion order of unique packages", () => {
        const result = deriveServiceName([
            "beta.v1.BetaService",
            "alpha.v1.AlphaService",
        ]);
        // Order should be beta.v1 first, then alpha.v1 (insertion order preserved by Set)
        assert.equal(result, `beta.v1/alpha.v1@${hostname()}`);
    });

    it("handles deeply nested package names", () => {
        const result = deriveServiceName(["com.example.order.v1.OrderService"]);
        assert.equal(result, `com.example.order.v1@${hostname()}`);
    });
});

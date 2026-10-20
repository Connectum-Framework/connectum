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

    it("uses the whole type name as the package when it has no dot (Connectum decision, no documented source)", () => {
        // The documented format is "{packageNames}@{hostname}", but nothing says what
        // the package of a service declared without a proto package is. Connectum
        // chose the whole type name (rather than an empty package or no name at all).
        const result = deriveServiceName(["SimpleService"]);
        assert.equal(result, `SimpleService@${hostname()}`);
    });

    it("lists packages in order of first appearance, not sorted (Connectum decision, no documented source)", () => {
        // The documented example ("order.v1/payment.v1@pod") shows packages joined with
        // "/" but does not say how they are ordered. Connectum chose the order in which
        // the services were registered. The same services registered in another order
        // therefore give a different broker client name. The input below is deliberately
        // not alphabetical so a sorting implementation cannot pass.
        const result = deriveServiceName([
            "beta.v1.BetaService",
            "alpha.v1.AlphaService",
        ]);
        assert.equal(result, `beta.v1/alpha.v1@${hostname()}`);
        const reversed = deriveServiceName([
            "alpha.v1.AlphaService",
            "beta.v1.BetaService",
        ]);
        assert.equal(reversed, `alpha.v1/beta.v1@${hostname()}`);
    });

    it("handles deeply nested package names", () => {
        const result = deriveServiceName(["com.example.order.v1.OrderService"]);
        assert.equal(result, `com.example.order.v1@${hostname()}`);
    });
});

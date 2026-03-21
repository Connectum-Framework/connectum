import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventRouterImpl } from "../../src/EventRouter.ts";

/**
 * Create a minimal fake DescService for testing EventRouterImpl.
 *
 * Uses the same pattern as EventBus.test.ts: provide a `proto: { options: undefined }`
 * on each method so resolveTopicName() falls back to `method.input.typeName`.
 */
function fakeDescService(typeName: string, methods: { localName: string; inputTypeName: string }[]) {
    return {
        typeName,
        methods: methods.map((m) => ({
            localName: m.localName,
            input: { typeName: m.inputTypeName },
            proto: { options: undefined },
        })),
    } as any;
}

describe("EventRouterImpl", () => {
    describe("serviceNames", () => {
        it("starts with empty serviceNames", () => {
            const router = new EventRouterImpl();
            assert.deepEqual(router.serviceNames, []);
        });

        it("collects typeName when service() is called", () => {
            const router = new EventRouterImpl();
            const service = fakeDescService("order.v1.OrderEventService", [
                { localName: "orderCreated", inputTypeName: "order.v1.OrderCreated" },
            ]);

            router.service(service, {
                orderCreated: async () => {},
            } as any);

            assert.deepEqual(router.serviceNames, ["order.v1.OrderEventService"]);
        });

        it("collects multiple service typeNames in registration order", () => {
            const router = new EventRouterImpl();

            const service1 = fakeDescService("order.v1.OrderEventService", [
                { localName: "orderCreated", inputTypeName: "order.v1.OrderCreated" },
            ]);
            const service2 = fakeDescService("payment.v1.PaymentEventService", [
                { localName: "paymentProcessed", inputTypeName: "payment.v1.PaymentProcessed" },
            ]);

            router.service(service1, { orderCreated: async () => {} } as any);
            router.service(service2, { paymentProcessed: async () => {} } as any);

            assert.deepEqual(router.serviceNames, [
                "order.v1.OrderEventService",
                "payment.v1.PaymentEventService",
            ]);
        });

        it("does not deduplicate -- same service registered twice produces duplicate entries", () => {
            const router = new EventRouterImpl();
            const service = fakeDescService("order.v1.OrderEventService", [
                { localName: "orderCreated", inputTypeName: "order.v1.OrderCreated" },
            ]);

            // Note: registering the same service twice would throw due to duplicate topic,
            // but serviceNames.push() happens BEFORE the topic check in entries.
            // Actually, the duplicate topic check happens in EventBus, not in EventRouter.
            // EventRouter simply pushes. Let's verify.
            router.service(service, { orderCreated: async () => {} } as any);
            // Second registration with same service would push to serviceNames again
            // but would also add a duplicate entry. EventRouterImpl allows this -- the
            // duplicate topic check is in EventBus.start().
            router.service(service, { orderCreated: async () => {} } as any);

            assert.deepEqual(router.serviceNames, [
                "order.v1.OrderEventService",
                "order.v1.OrderEventService",
            ]);
        });

        it("populates entries alongside serviceNames", () => {
            const router = new EventRouterImpl();
            const service = fakeDescService("order.v1.OrderEventService", [
                { localName: "orderCreated", inputTypeName: "order.v1.OrderCreated" },
                { localName: "orderUpdated", inputTypeName: "order.v1.OrderUpdated" },
            ]);

            router.service(service, {
                orderCreated: async () => {},
                orderUpdated: async () => {},
            } as any);

            assert.equal(router.entries.length, 2);
            assert.equal(router.serviceNames.length, 1);
            assert.equal(router.serviceNames[0], "order.v1.OrderEventService");
        });

        it("throws when handler is missing for a method", () => {
            const router = new EventRouterImpl();
            const service = fakeDescService("order.v1.OrderEventService", [
                { localName: "orderCreated", inputTypeName: "order.v1.OrderCreated" },
            ]);

            assert.throws(
                () => router.service(service, {} as any),
                { message: /Missing event handler.*orderCreated/ },
            );
        });
    });
});

/**
 * Compile-time regression tests for ServiceEventHandlers type.
 *
 * Verifies that ServiceEventHandlers correctly preserves concrete protobuf
 * input types from GenService descriptors instead of collapsing them to
 * the generic `Message` base type.
 *
 * Uses `satisfies` and conditional type assertions that cause compile errors
 * if types regress. Runtime assertions confirm the test file is executed.
 *
 * @see https://github.com/Connectum-Framework/connectum/issues/86
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@bufbuild/protobuf";
import type { GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";
import type { EventHandlerConfig, ServiceEventHandlers, TypedEventHandler } from "../../src/types.ts";

// =============================================================================
// Synthetic proto types (mimic codegen output without real .proto files)
// =============================================================================

/**
 * Synthetic message type -- represents a concrete protobuf message
 * like what codegen produces (e.g., OrderCreated).
 */
type OrderCreated = Message<"test.v1.OrderCreated"> & {
    readonly orderId: string;
    readonly amount: number;
};

/**
 * Synthetic message type for a second method.
 */
type OrderUpdated = Message<"test.v1.OrderUpdated"> & {
    readonly orderId: string;
    readonly newStatus: string;
};

/**
 * Synthetic GenMessage descriptors (mirrors codegen `const XxxSchema`).
 * We only need the type -- these are never instantiated at runtime.
 */
declare const OrderCreatedSchema: GenMessage<OrderCreated>;
declare const OrderUpdatedSchema: GenMessage<OrderUpdated>;

/**
 * Synthetic GenService -- mirrors what protoc-gen-es would generate:
 *
 * ```ts
 * export declare const OrderEventService: GenService<{
 *   orderCreated: { methodKind: "unary"; input: typeof OrderCreatedSchema; output: ... };
 *   orderUpdated: { methodKind: "unary"; input: typeof OrderUpdatedSchema; output: ... };
 * }>;
 * ```
 */
declare const OrderEventService: GenService<{
    orderCreated: {
        methodKind: "unary";
        input: typeof OrderCreatedSchema;
        output: typeof OrderCreatedSchema; // output is irrelevant for event handlers
    };
    orderUpdated: {
        methodKind: "unary";
        input: typeof OrderUpdatedSchema;
        output: typeof OrderUpdatedSchema;
    };
}>;

// =============================================================================
// Type-level helpers
// =============================================================================

/**
 * Compile-time assertion: `A extends B` must be true.
 * Produces a type error if A does not extend B.
 */
type AssertExtends<A, B> = A extends B ? true : never;

/**
 * Compile-time assertion: types A and B are exactly equal.
 * Uses the standard bidirectional-extends trick.
 */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// =============================================================================
// Compile-time assertions (cause build errors if ServiceEventHandlers regresses)
// =============================================================================

// Extract the handlers type for our synthetic service
type Handlers = ServiceEventHandlers<typeof OrderEventService>;

// 1. Handler keys must be the method localNames
type _KeysCheck = AssertExact<keyof Handlers, "orderCreated" | "orderUpdated">;

// 2. Each handler must accept the CONCRETE message type, not generic Message.
//    Since per-handler middleware support (Issue #49), handlers are a union:
//    TypedEventHandler<T> | EventHandlerConfig<T>
type _OrderCreatedHandler = AssertExact<
    Handlers["orderCreated"],
    TypedEventHandler<OrderCreated> | EventHandlerConfig<OrderCreated>
>;

type _OrderUpdatedHandler = AssertExact<
    Handlers["orderUpdated"],
    TypedEventHandler<OrderUpdated> | EventHandlerConfig<OrderUpdated>
>;

// 3. The concrete type must NOT be the generic fallback
type _NotGenericMessage = AssertExtends<
    Handlers["orderCreated"],
    TypedEventHandler<OrderCreated> | EventHandlerConfig<OrderCreated>
>;

// 4. Verify the concrete type has the domain field (orderId).
//    Extract<> narrows the union to the function form for Parameters<>.
type _HasOrderId = AssertExtends<
    Parameters<Extract<Handlers["orderCreated"], (...args: any) => any>>[0],
    { readonly orderId: string }
>;

// Force TypeScript to evaluate the assertions (unused types are not checked).
// Use void to suppress noUnusedLocals while keeping compile-time checks.
void ([true, true, true, true, true] satisfies [
    _KeysCheck,
    _OrderCreatedHandler,
    _OrderUpdatedHandler,
    _NotGenericMessage,
    _HasOrderId,
]);

// =============================================================================
// Runtime tests (verify the test file is executed by the runner)
// =============================================================================

describe("ServiceEventHandlers type", () => {
    it("compiles with correct concrete handler types (regression #86)", () => {
        // This test's value is in compilation -- if it compiles, the fix works.
        // The runtime assertion confirms the test was actually executed.
        assert.ok(true, "ServiceEventHandlers preserves concrete input types");
    });

    it("handler with concrete type compiles without casts", () => {
        // This function would fail to compile if handlers received Message<string>
        // instead of concrete OrderCreated -- accessing `.orderId` would be an error.
        const handler: Handlers["orderCreated"] = async (event, _ctx) => {
            // Access domain-specific fields without any cast
            void (event.orderId satisfies string);
            void (event.amount satisfies number);
        };

        assert.equal(typeof handler, "function");
    });

    it("handler object satisfies ServiceEventHandlers", () => {
        // Full handlers object must compile with concrete types
        const handlers = {
            orderCreated: async (event, _ctx) => {
                void (event.orderId satisfies string);
            },
            orderUpdated: async (event, _ctx) => {
                void (event.newStatus satisfies string);
            },
        } satisfies Handlers;

        assert.equal(Object.keys(handlers).length, 2);
    });
});

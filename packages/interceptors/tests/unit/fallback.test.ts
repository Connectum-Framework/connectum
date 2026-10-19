/**
 * Fallback interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockNext, createMockNextError, createMockRequest } from "@connectum/test-fixtures";
import { createFallbackInterceptor } from "../../src/fallback.ts";

describe("fallback interceptor", () => {
    it("should pass request on success", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "value" }),
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
    });

    it("should call handler on failure", async () => {
        let handlerCalled = false;
        const interceptor = createFallbackInterceptor({
            handler: () => {
                handlerCalled = true;
                return { fallback: "value" };
            },
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        await handler(mockReq);

        assert.strictEqual(handlerCalled, true);
    });

    it("should return fallback value from handler", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "cached_data" }),
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.deepStrictEqual(result.message, { fallback: "cached_data" });
    });

    it("should propagate error if handler throws", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => {
                throw new Error("Fallback also failed");
            },
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof Error);
                assert.strictEqual(err.message, "Fallback also failed");
                return true;
            },
        );
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const fallbackHandler = mock.fn(() => ({ fallback: "value" }));
        const interceptor = createFallbackInterceptor({
            handler: fallbackHandler,
            skipStreaming: true,
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });

        // A failing streaming call: with the fallback applied it would turn into a substitute response.
        // Skipped, the failure reaches the caller untouched and the fallback handler is never asked.
        const failure = new ConnectError("Service error", Code.Internal);
        const next = mock.fn(async () => {
            throw failure;
        });

        const handler = interceptor(next as any);
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => err === failure,
        );
        assert.strictEqual(fallbackHandler.mock.calls.length, 0);
    });

    it("should handle async handler", async () => {
        const interceptor = createFallbackInterceptor({
            handler: async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return { fallback: "async_value" };
            },
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.deepStrictEqual(result.message, { fallback: "async_value" });
    });

    it("should activate fallback on error", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "value" }),
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.deepStrictEqual(result.message, { fallback: "value" });
    });

    it("should preserve original error context", async () => {
        let capturedError: Error | null = null;
        const interceptor = createFallbackInterceptor({
            handler: (error) => {
                capturedError = error;
                return { fallback: "value" };
            },
        });

        const originalError = new ConnectError("Original service error", Code.Internal);

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = mock.fn(async () => {
            throw originalError;
        });

        const handler = interceptor(next as any);
        await handler(mockReq);

        assert.strictEqual(capturedError, originalError);
        assert(capturedError !== null);
        assert((capturedError as unknown as object) instanceof Error);
        assert.strictEqual((capturedError as ConnectError).code, Code.Internal);
    });

    // The handler is required and must be a function (FallbackOptions.handler); anything else is refused
    // when the interceptor is created, not on the first failure.
    for (const [label, value] of [
        ["a string", "not a function"],
        ["undefined", undefined],
        ["null", null],
        ["an object", { fallback: "value" }],
        ["a number", 42],
    ] as const) {
        it(`should reject ${label} as the handler with a TypeError`, () => {
            assert.throws(
                () =>
                    createFallbackInterceptor({
                        handler: value as unknown as () => unknown,
                    }),
                (err: unknown) => err instanceof TypeError && err.message === "createFallbackInterceptor: handler must be a function",
            );
        });
    }

    it("should handle handler returning different types", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => null,
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(result.message, null);
    });

    describe("fallback response properties", () => {
        it("should return response with correct service, method, and stream: false", async () => {
            const interceptor = createFallbackInterceptor({
                handler: () => ({ fallback: "data" }),
            });

            const mockReq = createMockRequest({
                service: "my.package.MyService",
                method: "GetItems",
                message: { id: 1 },
            });

            const next = createMockNextError(Code.Internal, "Service error");

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual(result.stream, false, "fallback response should have stream: false");
            assert.strictEqual(
                result.service.typeName,
                "my.package.MyService",
                "fallback response should preserve service",
            );
            assert.strictEqual(result.method.name, "GetItems", "fallback response should preserve method");
            assert.deepStrictEqual(result.message, { fallback: "data" });
        });

        it("should handle async fallback handler that resolves", async () => {
            const interceptor = createFallbackInterceptor({
                handler: async () => {
                    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
                    return { items: [], total: 0 };
                },
            });

            const mockReq = createMockRequest({
                service: "test.Service",
                method: "Method",
                message: { field: "value" },
            });

            const next = createMockNextError(Code.Unavailable, "Service unavailable");

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.deepStrictEqual(result.message, { items: [], total: 0 });
            assert.strictEqual(result.stream, false);
        });

        it("should propagate error when async fallback handler rejects", async () => {
            const interceptor = createFallbackInterceptor({
                handler: async () => {
                    throw new Error("Async fallback failed");
                },
            });

            const mockReq = createMockRequest({
                service: "test.Service",
                method: "Method",
                message: { field: "value" },
            });

            const next = createMockNextError(Code.Internal, "Service error");

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual(err.message, "Async fallback failed");
                    return true;
                },
            );
        });
    });
});

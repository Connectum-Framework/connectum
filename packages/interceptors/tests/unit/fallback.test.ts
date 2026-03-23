/**
 * Fallback interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockNext, createMockNextError, createMockRequest } from "@connectum/testing";
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
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "value" }),
            skipStreaming: true,
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });

        const next = createMockNext({ message: { result: "streaming" } });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "streaming");
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

    it("should reject invalid handler", () => {
        assert.throws(
            () =>
                createFallbackInterceptor({
                    handler: "not a function" as unknown as () => unknown,
                }),
            /handler must be a function/,
        );
    });

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

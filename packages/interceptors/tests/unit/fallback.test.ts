/**
 * Fallback interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createFallbackInterceptor } from "../../src/fallback.ts";

describe("fallback interceptor", () => {
    it("should pass request on success", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "value" }),
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => ({ message: { result: "success" } }));

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

        const handler = interceptor(next as any);
        await handler(mockReq);

        assert.strictEqual(handlerCalled, true);
    });

    it("should return fallback value from handler", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "cached_data" }),
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: true, // Streaming request
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => ({ message: { result: "streaming" } }));

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.deepStrictEqual(result.message, { fallback: "async_value" });
    });

    it("should activate fallback on error", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ fallback: "value" }),
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(result.message, null);
    });
});

/**
 * Error handler interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createErrorHandlerInterceptor } from "../../src/errorHandler.ts";

describe("errorHandler interceptor", () => {
    const mockReq = {
        url: "http://localhost/test.Service/Method",
        stream: false,
        message: { field: "value" },
        service: { typeName: "test.Service" },
    } as any;

    it("should pass through successful requests", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => ({ message: { result: "success" } }));

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should transform unknown errors to ConnectError with Internal code", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => {
            throw new Error("something went wrong");
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Internal);
                return true;
            },
        );
    });

    it("should preserve ConnectError code from original error", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => {
            throw new ConnectError("not found", Code.NotFound);
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.NotFound);
                return true;
            },
        );
    });

    it("should preserve numeric error code from plain objects with .code", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => {
            const error = new Error("permission denied") as Error & { code: number };
            error.code = Code.PermissionDenied;
            throw error;
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.PermissionDenied);
                return true;
            },
        );
    });

    it("should log errors when logErrors is true", async () => {
        const originalError = mock.method(console, "error", () => {});

        const interceptor = createErrorHandlerInterceptor({ logErrors: true, includeStackTrace: false });

        const next = mock.fn(async () => {
            throw new Error("test error");
        });

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        assert.ok(
            originalError.mock.calls.length >= 2,
            `Expected at least 2 console.error calls, got ${originalError.mock.calls.length}`,
        );

        // First call: "Interceptor caught error:"
        assert.strictEqual(originalError.mock.calls[0]!.arguments[0], "Interceptor caught error:");

        // Second call: "Transformed ConnectError:"
        assert.strictEqual(originalError.mock.calls[1]!.arguments[0], "Transformed ConnectError:");

        originalError.mock.restore();
    });

    it("should not log errors when logErrors is false", async () => {
        const originalError = mock.method(console, "error", () => {});

        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => {
            throw new Error("test error");
        });

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        assert.strictEqual(originalError.mock.calls.length, 0);

        originalError.mock.restore();
    });

    it("should log stack trace when includeStackTrace is true", async () => {
        const originalError = mock.method(console, "error", () => {});

        const interceptor = createErrorHandlerInterceptor({ logErrors: true, includeStackTrace: true });

        const next = mock.fn(async () => {
            throw new Error("test error with stack");
        });

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        // Should have 3 calls: "Interceptor caught error:", "Transformed ConnectError:", "Stack trace:"
        assert.ok(
            originalError.mock.calls.length >= 3,
            `Expected at least 3 console.error calls, got ${originalError.mock.calls.length}`,
        );

        assert.strictEqual(originalError.mock.calls[2]!.arguments[0], "Stack trace:");

        originalError.mock.restore();
    });

    it("should not log stack trace when includeStackTrace is false", async () => {
        const originalError = mock.method(console, "error", () => {});

        const interceptor = createErrorHandlerInterceptor({ logErrors: true, includeStackTrace: false });

        const next = mock.fn(async () => {
            throw new Error("test error");
        });

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        // Should have exactly 2 calls: "Interceptor caught error:", "Transformed ConnectError:"
        assert.strictEqual(originalError.mock.calls.length, 2);

        // Verify no "Stack trace:" call
        for (const call of originalError.mock.calls) {
            assert.notStrictEqual(call.arguments[0], "Stack trace:");
        }

        originalError.mock.restore();
    });

    it("should use default options (no args)", async () => {
        const originalError = mock.method(console, "error", () => {});

        // Default: logErrors and includeStackTrace depend on NODE_ENV
        const interceptor = createErrorHandlerInterceptor();

        const next = mock.fn(async () => ({ message: { result: "ok" } }));

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "ok");
        assert.strictEqual(next.mock.calls.length, 1);

        originalError.mock.restore();
    });

    it("should handle string errors", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => {
            throw "string error";
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Internal);
                return true;
            },
        );
    });
});

/**
 * Error handler interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextError, createMockRequest } from "@connectum/testing";
import { createErrorHandlerInterceptor } from "../../src/errorHandler.ts";

describe("errorHandler interceptor", () => {
    const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

    it("should pass through successful requests", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = createMockNext();

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
                assertConnectError(err, Code.Internal);
                return true;
            },
        );
    });

    it("should preserve ConnectError code from original error", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = createMockNextError(Code.NotFound, "not found");

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.NotFound);
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
                assertConnectError(err, Code.PermissionDenied);
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

        const next = createMockNext({ message: { result: "ok" } });

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
                assertConnectError(err, Code.Internal);
                return true;
            },
        );
    });

    describe("additional error scenarios", () => {
        it("should wrap non-Error thrown value (string) via ConnectError.from", async () => {
            const interceptor = createErrorHandlerInterceptor({ logErrors: false });

            const next = mock.fn(async () => {
                throw "plain string thrown";
            });

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    assert.ok(err instanceof ConnectError, "should be a ConnectError instance");
                    assert.ok(err.message.includes("plain string thrown"), "should preserve original message");
                    return true;
                },
            );
        });

        it("should default to Code.Internal when Error has no code property", async () => {
            const interceptor = createErrorHandlerInterceptor({ logErrors: false });

            const next = mock.fn(async () => {
                throw new Error("error without code");
            });

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        });

        it("should pass serverDetails to onError callback for SanitizableError", async () => {
            let capturedInfo: {
                error: Error;
                code: number;
                serverDetails?: Readonly<Record<string, unknown>>;
                stack?: string;
            } | null = null;

            const interceptor = createErrorHandlerInterceptor({
                logErrors: false,
                onError: (info) => {
                    capturedInfo = info;
                },
            });

            const sanitizableError = Object.assign(new Error("internal db error"), {
                clientMessage: "Something went wrong",
                serverDetails: { query: "SELECT *", table: "users", duration: 150 },
                code: Code.Internal,
            });

            const next = mock.fn(async () => {
                throw sanitizableError;
            });

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal, "Something went wrong");
                    return true;
                },
            );

            // capturedInfo is assigned inside onError callback; TypeScript CFA doesn't track it
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const info = capturedInfo as any;
            assert.ok(info, "onError callback should have been called");
            assert.ok(info.serverDetails, "serverDetails should be present");
            assert.strictEqual(info.serverDetails.query, "SELECT *");
            assert.strictEqual(info.serverDetails.table, "users");
            assert.strictEqual(info.serverDetails.duration, 150);
            assert.strictEqual(info.code, Code.Internal);
        });

        it("should be silent with logErrors: false and no onError callback", async () => {
            const consoleErrorMock = mock.method(console, "error", () => {});

            const interceptor = createErrorHandlerInterceptor({ logErrors: false });

            const next = mock.fn(async () => {
                throw new Error("silent error");
            });

            const handler = interceptor(next as any);

            await assert.rejects(() => handler(mockReq));

            assert.strictEqual(consoleErrorMock.mock.calls.length, 0, "console.error should not be called");

            consoleErrorMock.mock.restore();
        });
    });
});

/**
 * Error handler interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextError, createMockRequest } from "@connectum/test-fixtures";
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

    // Oracle: the custom-interceptors guide (docs en/guide/interceptors/custom.md, warning
    // under "Rate limiting") states that errorHandler gives a non-Connect error with a
    // numeric `code` that code, and every error without a numeric `code` Code.Internal.
    // PermissionDenied (7) is deliberately not the Internal default (13), so a handler
    // that ignored `code` would fail here.
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

    // Same documented rule from the other side: only a numeric `code` is adopted; any
    // other kind of `code` value counts as "no code" and yields Code.Internal.
    it("should ignore a non-numeric .code and fall back to Code.Internal", async () => {
        const interceptor = createErrorHandlerInterceptor({ logErrors: false });

        const next = mock.fn(async () => {
            const error = new Error("driver failure") as Error & { code: string };
            error.code = "ECONNRESET";
            throw error;
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
        // Oracle for the code: the custom-interceptors guide (docs en/guide/interceptors/custom.md)
        // says errors without a numeric `code` get Code.Internal. The text of such a failure
        // stays on the server (CWE-209; Connect-ES itself answers "internal error" for a
        // handler exception when no interceptor is installed), so the client text is
        // asserted in the "text of non-Connect failures" block below. The original thrown
        // value is kept as `cause` so server-side logging can still see it.
        it("should wrap non-Error thrown value (string) into ConnectError with Code.Internal", async () => {
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
                    assert.strictEqual(err.cause, "plain string thrown", "original thrown value should stay available as cause");
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

    // Oracle: CWE-209 (error messages must not expose internals) and the Connect protocol
    // documentation, under which a handler exception that is not a ConnectError reaches the
    // client as code `internal` with the generic text "internal error". Only a ConnectError
    // (or a SanitizableError's clientMessage) is a deliberate client-facing message.
    describe("text of non-Connect failures", () => {
        const SECRET = "hunter2";
        type OnErrorInfo = Parameters<NonNullable<NonNullable<Parameters<typeof createErrorHandlerInterceptor>[0]>["onError"]>>[0];

        /** Everything a transport puts on the wire for a ConnectError: text, details, metadata. */
        function wireOf(err: ConnectError): string {
            return JSON.stringify({ message: err.rawMessage, details: err.details, metadata: [...err.metadata] });
        }

        async function thrownBy(value: unknown, options: Parameters<typeof createErrorHandlerInterceptor>[0] = {}): Promise<unknown> {
            const interceptor = createErrorHandlerInterceptor({ logErrors: false, ...options });
            const next = mock.fn(async () => {
                throw value;
            });
            try {
                await interceptor(next as any)(mockReq);
            } catch (err) {
                return err;
            }
            assert.fail("interceptor should have rejected");
        }

        it("sends only the generic text for an Error and keeps the original as cause", async () => {
            const original = new Error(`db connect failed: password=${SECRET}`);
            const err = await thrownBy(original);

            assertConnectError(err, Code.Internal);
            assert.strictEqual(err.rawMessage, "internal error");
            assert.strictEqual(err.cause, original);
            assert.ok(!wireOf(err).includes(SECRET), "secret must not be on the wire");
        });

        it("sends only the generic text for a thrown string", async () => {
            const original = `raw string with ${SECRET}`;
            const err = await thrownBy(original);

            assertConnectError(err, Code.Internal);
            assert.strictEqual(err.rawMessage, "internal error");
            assert.strictEqual(err.cause, original);
            assert.ok(!wireOf(err).includes(SECRET), "secret must not be on the wire");
        });

        it("keeps a numeric error code but sends an empty text", async () => {
            const original = Object.assign(new Error(`rule admin-only rejected ${SECRET}`), { code: Code.PermissionDenied });
            const err = await thrownBy(original);

            assertConnectError(err, Code.PermissionDenied);
            assert.strictEqual(err.rawMessage, "");
            assert.strictEqual(err.cause, original);
            assert.ok(!wireOf(err).includes(SECRET), "secret must not be on the wire");
        });

        it("maps an AbortError to Canceled without its text", async () => {
            const original = new DOMException(`aborted while holding ${SECRET}`, "AbortError");
            const err = await thrownBy(original);

            assertConnectError(err, Code.Canceled);
            assert.strictEqual(err.rawMessage, "");
            assert.ok(!wireOf(err).includes(SECRET), "secret must not be on the wire");
        });

        it("sends the original text when exposeErrorMessages is true", async () => {
            const original = new Error(`db connect failed: password=${SECRET}`);
            const err = await thrownBy(original, { exposeErrorMessages: true });

            assertConnectError(err, Code.Internal);
            assert.strictEqual(err.rawMessage, original.message);
        });

        it("sends the original text of a thrown string and a coded error when exposeErrorMessages is true", async () => {
            const asString = await thrownBy(`raw ${SECRET}`, { exposeErrorMessages: true });
            assertConnectError(asString, Code.Internal);
            assert.strictEqual(asString.rawMessage, `raw ${SECRET}`);

            const coded = await thrownBy(Object.assign(new Error("denied by rule"), { code: Code.PermissionDenied }), { exposeErrorMessages: true });
            assertConnectError(coded, Code.PermissionDenied);
            assert.strictEqual(coded.rawMessage, "denied by rule");
        });

        for (const exposeErrorMessages of [false, true]) {
            it(`hands onError the full error with the original text and cause (exposeErrorMessages: ${exposeErrorMessages})`, async () => {
                let captured: OnErrorInfo | undefined;
                const original = new Error(`db connect failed: password=${SECRET}`);

                await thrownBy(original, {
                    exposeErrorMessages,
                    includeStackTrace: true,
                    onError: (info) => {
                        captured = info;
                    },
                });

                assert.ok(captured, "onError should have been called");
                assert.strictEqual(captured.code, Code.Internal);
                assert.ok(captured.error instanceof ConnectError);
                assert.strictEqual(captured.error.rawMessage, original.message);
                assert.strictEqual(captured.error.cause, original);
                assert.ok(captured.stack, "stack should be passed when includeStackTrace is true");
            });
        }

        it("logs the original failure and the client-facing ConnectError under the existing labels", async () => {
            const consoleErrorMock = mock.method(console, "error", () => {});
            try {
                const original = new Error(`db connect failed: password=${SECRET}`);
                await thrownBy(original, { logErrors: true, includeStackTrace: false });

                const calls = consoleErrorMock.mock.calls;
                assert.strictEqual(calls[0]!.arguments[0], "Interceptor caught error:");
                assert.strictEqual(calls[0]!.arguments[1], original, "log must carry the original failure");
                assert.strictEqual(calls[1]!.arguments[0], "Transformed ConnectError:");
                const logged = calls[1]!.arguments[1] as ConnectError;
                assert.strictEqual(logged.rawMessage, "internal error", "the transformed line shows what the client gets");
            } finally {
                consoleErrorMock.mock.restore();
            }
        });

        it("passes a ConnectError through unchanged, text, details and metadata included", async () => {
            const original = new ConnectError(`user 42 not found ${SECRET}`, Code.NotFound, { "x-trace": "abc" });
            const err = await thrownBy(original);

            assert.strictEqual(err, original);
            assertConnectError(err, Code.NotFound);
            assert.strictEqual(err.rawMessage, `user 42 not found ${SECRET}`);
            assert.strictEqual(err.metadata.get("x-trace"), "abc");
        });

        it("sends a SanitizableError's clientMessage and code, never its own text or serverDetails", async () => {
            const original = Object.assign(new Error(`internal db error ${SECRET}`), {
                clientMessage: "Something went wrong",
                serverDetails: { query: `SELECT ${SECRET}` },
                code: Code.Internal,
            });
            const err = await thrownBy(original);

            assertConnectError(err, Code.Internal);
            assert.strictEqual(err.rawMessage, "Something went wrong");
            assert.ok(!wireOf(err).includes(SECRET), "secret must not be on the wire");
        });
    });
});

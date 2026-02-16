/**
 * Circuit breaker interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createCircuitBreakerInterceptor } from "../../src/circuit-breaker.ts";

describe("circuit breaker interceptor", () => {
    it("should pass request when circuit closed", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 3 });

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
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should open circuit after threshold failures", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 3, halfOpenAfter: 60_000 });

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

        // First 3 failures should throw Internal errors
        for (let i = 0; i < 3; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assert(err instanceof ConnectError);
                    assert.strictEqual((err as ConnectError).code, Code.Internal);
                    return true;
                },
            );
        }

        // 4th attempt should get circuit open error (Unavailable)
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Unavailable);
                assert((err as ConnectError).message.includes("Circuit breaker is open"));
                return true;
            },
        );
    });

    it("should reject requests when circuit open", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 10 });

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

        // Trigger circuit open (2 failures)
        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => handler(mockReq));
        }

        // Circuit should be open now - immediate rejection with Unavailable
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Unavailable);
                return true;
            },
        );
    });

    it("should enter half-open state after timeout", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 100 });

        let callCount = 0;
        const next = mock.fn(async () => {
            callCount++;
            if (callCount <= 2) {
                throw new ConnectError("Service error", Code.Internal);
            }
            return { message: { result: "recovered" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Trigger circuit open (2 failures)
        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => handler(mockReq));
        }

        // Wait for half-open timeout
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Should allow one request through in half-open state
        const result = await handler(mockReq);
        assert.strictEqual((result.message as any).result, "recovered");
    });

    it("should close circuit on success in half-open", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 100 });

        let callCount = 0;
        const next = mock.fn(async () => {
            callCount++;
            if (callCount <= 2) {
                throw new ConnectError("Service error", Code.Internal);
            }
            return { message: { result: "recovered" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Open circuit
        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => handler(mockReq));
        }

        // Wait for half-open
        await new Promise((resolve) => setTimeout(resolve, 150));

        // First success should close circuit
        await handler(mockReq);

        // Subsequent requests should work normally
        const result = await handler(mockReq);
        assert.strictEqual((result.message as any).result, "recovered");
    });

    it("should re-open circuit on failure in half-open", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 100 });

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Open circuit
        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => handler(mockReq));
        }

        // Wait for half-open
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Failure in half-open should re-open circuit
        await assert.rejects(() => handler(mockReq));

        // Next request should be immediately rejected (circuit open again)
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Unavailable);
                return true;
            },
        );
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 1, skipStreaming: true });

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
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should handle custom threshold", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 5, halfOpenAfter: 10 });

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

        // Should require 5 failures to open circuit
        for (let i = 0; i < 5; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assert.strictEqual((err as ConnectError).code, Code.Internal);
                    return true;
                },
            );
        }

        // 6th should be rejected with Unavailable
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert.strictEqual((err as ConnectError).code, Code.Unavailable);
                return true;
            },
        );
    });

    it("should handle custom halfOpenAfter", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 50 });

        let callCount = 0;
        const next = mock.fn(async () => {
            callCount++;
            if (callCount <= 2) {
                throw new ConnectError("Service error", Code.Internal);
            }
            return { message: { result: "recovered" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Open circuit
        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => handler(mockReq));
        }

        // Wait for custom half-open timeout
        await new Promise((resolve) => setTimeout(resolve, 75));

        // Should allow request through
        const result = await handler(mockReq);
        assert.strictEqual((result.message as any).result, "recovered");
    });

    it("should reject invalid threshold", () => {
        assert.throws(() => createCircuitBreakerInterceptor({ threshold: 0 }), /threshold must be a positive finite number/);
        assert.throws(() => createCircuitBreakerInterceptor({ threshold: -1 }), /threshold must be a positive finite number/);
        assert.throws(() => createCircuitBreakerInterceptor({ threshold: Number.POSITIVE_INFINITY }), /threshold must be a positive finite number/);
    });

    it("should reject invalid halfOpenAfter", () => {
        assert.throws(() => createCircuitBreakerInterceptor({ halfOpenAfter: -1 }), /halfOpenAfter must be a non-negative finite number/);
        assert.throws(
            () => createCircuitBreakerInterceptor({ halfOpenAfter: Number.POSITIVE_INFINITY }),
            /halfOpenAfter must be a non-negative finite number/,
        );
    });
});

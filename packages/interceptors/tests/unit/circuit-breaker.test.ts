/**
 * Circuit breaker interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextError, createMockRequest } from "@connectum/testing";
import { createCircuitBreakerInterceptor, defaultFailurePredicate } from "../../src/circuit-breaker.ts";
import { createRetryInterceptor } from "../../src/retry.ts";

/**
 * Compose interceptors with Connect-ES semantics: interceptors[0] is
 * outermost (applyInterceptors iterates the reversed array and wraps).
 */
function composeInterceptors(interceptors: Interceptor[], next: any): any {
    let wrapped = next;
    for (const i of interceptors.concat().reverse()) {
        wrapped = i(wrapped);
    }
    return wrapped;
}

describe("circuit breaker interceptor", () => {
    it("should pass request when circuit closed", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 3 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should open circuit after threshold failures", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 3, halfOpenAfter: 60_000 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        // First 3 failures should throw Internal errors
        for (let i = 0; i < 3; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        }

        // 4th attempt should get circuit open error (Unavailable)
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable, "Circuit breaker is open");
                return true;
            },
        );
    });

    it("should reject requests when circuit open", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 60_000 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        // Trigger circuit open (2 failures)
        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => handler(mockReq));
        }

        // Circuit should be open now - immediate rejection with Unavailable
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable);
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

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

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

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

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

        const next = createMockNextError(Code.Internal, "Service error");

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

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
                assertConnectError(err, Code.Unavailable);
                return true;
            },
        );
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 1, skipStreaming: true });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });

        const next = createMockNext({ message: { result: "streaming" } });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "streaming");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should handle custom threshold", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 5, halfOpenAfter: 60_000 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        // Should require 5 failures to open circuit
        for (let i = 0; i < 5; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        }

        // 6th should be rejected with Unavailable
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable);
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

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

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

    describe("failure classification", () => {
        const mockReq = () => createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        it("should not open circuit on business errors (default predicate)", async () => {
            const interceptor = createCircuitBreakerInterceptor({ threshold: 5, halfOpenAfter: 60_000 });
            const next = createMockNextError(Code.InvalidArgument, "bad scan code");
            const handler = interceptor(next as any);

            // 5 consecutive business errors must NOT trip the breaker...
            for (let i = 0; i < 5; i++) {
                await assert.rejects(
                    () => handler(mockReq()),
                    (err: unknown) => {
                        assertConnectError(err, Code.InvalidArgument);
                        return true;
                    },
                );
            }

            // ...and the 6th call still reaches next (circuit closed)
            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 6);
        });

        it("should open circuit on infrastructure errors (resource_exhausted)", async () => {
            const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 60_000 });
            const next = createMockNextError(Code.ResourceExhausted, "upstream overloaded");
            const handler = interceptor(next as any);

            for (let i = 0; i < 2; i++) {
                await assert.rejects(() => handler(mockReq()));
            }

            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable, "Circuit breaker is open");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 2);
        });

        it("should count non-ConnectError values as failures", async () => {
            const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 60_000 });
            const next = mock.fn(async () => {
                throw new Error("plain runtime fault");
            });
            const handler = interceptor(next as any);

            for (let i = 0; i < 2; i++) {
                await assert.rejects(() => handler(mockReq()), /plain runtime fault/);
            }

            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
        });

        it("should let custom predicate override the default (not_found opens)", async () => {
            const interceptor = createCircuitBreakerInterceptor({
                threshold: 2,
                halfOpenAfter: 60_000,
                failurePredicate: (err) => err instanceof ConnectError && err.code === Code.NotFound,
            });
            const next = createMockNextError(Code.NotFound, "missing");
            const handler = interceptor(next as any);

            for (let i = 0; i < 2; i++) {
                await assert.rejects(() => handler(mockReq()));
            }

            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
        });

        it("should compose with the default predicate (exclude resource_exhausted)", async () => {
            const interceptor = createCircuitBreakerInterceptor({
                threshold: 2,
                halfOpenAfter: 60_000,
                failurePredicate: (err, def) => def(err) && !(err instanceof ConnectError && err.code === Code.ResourceExhausted),
            });
            const next = createMockNextError(Code.ResourceExhausted, "rate limited");
            const handler = interceptor(next as any);

            // 5 rate-limit errors with threshold 2: circuit must stay closed
            for (let i = 0; i < 5; i++) {
                await assert.rejects(
                    () => handler(mockReq()),
                    (err: unknown) => {
                        assertConnectError(err, Code.ResourceExhausted);
                        return true;
                    },
                );
            }
            assert.strictEqual(next.mock.calls.length, 5);
        });

        it("should restore legacy all-errors behavior with () => true", async () => {
            const interceptor = createCircuitBreakerInterceptor({
                threshold: 2,
                halfOpenAfter: 60_000,
                failurePredicate: () => true,
            });
            const next = createMockNextError(Code.InvalidArgument, "bad input");
            const handler = interceptor(next as any);

            for (let i = 0; i < 2; i++) {
                await assert.rejects(() => handler(mockReq()));
            }

            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
        });

        it("should count error as failure when predicate throws (fail-closed)", async () => {
            const interceptor = createCircuitBreakerInterceptor({
                threshold: 2,
                halfOpenAfter: 60_000,
                failurePredicate: () => {
                    throw new Error("buggy classifier");
                },
            });
            const next = createMockNextError(Code.NotFound, "missing");
            const handler = interceptor(next as any);

            // Caller must receive the ORIGINAL upstream error, not the predicate's
            for (let i = 0; i < 2; i++) {
                await assert.rejects(
                    () => handler(mockReq()),
                    (err: unknown) => {
                        assertConnectError(err, Code.NotFound);
                        return true;
                    },
                );
            }

            // Despite NotFound being a non-failure by default, the throwing
            // predicate fails closed: circuit is open
            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
        });

        it("should close circuit on business error in half-open", async () => {
            const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 100 });

            let callCount = 0;
            const next = mock.fn(async () => {
                callCount++;
                if (callCount <= 2) {
                    throw new ConnectError("infra down", Code.Internal);
                }
                throw new ConnectError("bad input", Code.InvalidArgument);
            });
            const handler = interceptor(next as any);

            // Open circuit with infrastructure errors
            for (let i = 0; i < 2; i++) {
                await assert.rejects(() => handler(mockReq()));
            }

            await new Promise((resolve) => setTimeout(resolve, 150));

            // Half-open probe rejects with a business error → treated as a
            // successful probe (cockatiel "unhandled" path) → circuit closes
            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument);
                    return true;
                },
            );

            // Circuit closed: next call reaches next again
            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 4);
        });

        it("should re-open circuit on infrastructure error in half-open", async () => {
            const interceptor = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 100 });
            const next = createMockNextError(Code.Internal, "still down");
            const handler = interceptor(next as any);

            for (let i = 0; i < 2; i++) {
                await assert.rejects(() => handler(mockReq()));
            }

            await new Promise((resolve) => setTimeout(resolve, 150));

            // Half-open probe fails with infra error → re-open
            await assert.rejects(() => handler(mockReq()));

            await assert.rejects(
                () => handler(mockReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
        });

        it("defaultFailurePredicate classifies codes as documented", () => {
            const failureCodes = [Code.Unknown, Code.DeadlineExceeded, Code.Internal, Code.Unavailable, Code.DataLoss, Code.ResourceExhausted];
            const nonFailureCodes = [
                Code.Canceled,
                Code.InvalidArgument,
                Code.NotFound,
                Code.AlreadyExists,
                Code.PermissionDenied,
                Code.FailedPrecondition,
                Code.Aborted,
                Code.OutOfRange,
                Code.Unimplemented,
                Code.Unauthenticated,
            ];

            for (const code of failureCodes) {
                assert.strictEqual(defaultFailurePredicate(new ConnectError("x", code)), true, `Code ${code} must be a failure`);
            }
            for (const code of nonFailureCodes) {
                assert.strictEqual(defaultFailurePredicate(new ConnectError("x", code)), false, `Code ${code} must not be a failure`);
            }
            assert.strictEqual(defaultFailurePredicate(new Error("plain")), true);
            assert.strictEqual(defaultFailurePredicate("string throw"), true);
        });
    });

    describe("ordering: breaker wraps retry (interceptors[0] outermost)", () => {
        it("should increment failure counter once per logical call despite retries", async () => {
            // Same relative order as createDefaultInterceptors: breaker before retry
            const breaker = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 60_000 });
            const retry = createRetryInterceptor({ maxRetries: 3, initialDelay: 1, maxDelay: 5 });

            const next = mock.fn(async () => {
                throw new ConnectError("down", Code.Unavailable);
            });
            const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

            const handler = composeInterceptors([breaker, retry], next as any);

            // One logical call: retry exhausts attempts inside the breaker.
            // Breaker counts ONE failure (threshold 2 → still closed).
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
            assert.ok(next.mock.calls.length > 1, "retry must have produced multiple attempts");

            const attemptsAfterFirstCall = next.mock.calls.length;

            // Circuit must still be CLOSED: second logical call reaches next again
            await assert.rejects(() => handler(mockReq));
            assert.ok(next.mock.calls.length > attemptsAfterFirstCall, "second logical call must reach next — circuit closed after one logical failure");
        });
    });
});

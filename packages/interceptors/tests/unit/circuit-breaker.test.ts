/**
 * Circuit breaker interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextError, createMockRequest } from "@connectum/test-fixtures";
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

    // The documented defaults: five consecutive failures open the circuit, and it
    // stays open for 30000 ms. A virtual clock stands in for the 30 s; the breaker
    // reads the time on the next call, so the clock is moved and the call made.
    it("should open after 5 consecutive failures by default", async () => {
        const interceptor = createCircuitBreakerInterceptor();
        const next = createMockNextError(Code.Internal, "Service error");
        const handler = interceptor(next as any);
        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        for (let i = 0; i < 5; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        }
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable, "Circuit breaker is open");
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 5, "the sixth call must be refused without reaching the downstream");
    });

    it("should stay open for 30000 ms by default and let one probe through at that point", async (t) => {
        t.mock.timers.enable({ apis: ["Date"] });
        const interceptor = createCircuitBreakerInterceptor({ threshold: 1 });
        let failing = true;
        const next = mock.fn(async () => {
            if (failing) {
                throw new ConnectError("Service error", Code.Internal);
            }
            return { message: { result: "recovered" } };
        });
        const handler = interceptor(next as any);
        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        await assert.rejects(() => handler(mockReq));
        failing = false;

        t.mock.timers.tick(29_999);
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable, "Circuit breaker is open");
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 1, "the circuit must still be open 1 ms before the default delay");

        t.mock.timers.tick(1);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "recovered");
        assert.strictEqual(next.mock.calls.length, 2);
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
        const interceptor = createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 60_000, skipStreaming: true });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });

        // A failing streaming call: with threshold 1 a single failure would open the circuit, and the
        // next call would be refused with Unavailable. Skipped, the breaker never sees the failures,
        // so every call reaches the downstream and gets its own error.
        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        for (let i = 0; i < 3; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        }
        assert.strictEqual(next.mock.calls.length, 3);
    });

    // skipStreaming is not given: streaming failures are not counted by default.
    it("should skip streaming by default", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 60_000 });
        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });
        const next = createMockNextError(Code.Internal, "Service error");
        const handler = interceptor(next as any);

        for (let i = 0; i < 3; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        }
        assert.strictEqual(next.mock.calls.length, 3);
    });

    it("should count streaming failures when skipStreaming=false", async () => {
        const interceptor = createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 60_000, skipStreaming: false });
        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });
        const next = createMockNextError(Code.Internal, "Service error");
        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Internal);
                return true;
            },
        );
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable, "Circuit breaker is open");
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 1);
    });

    for (const threshold of [2, 7]) {
        it(`should handle custom threshold (${threshold}, the default is 5)`, async () => {
            const interceptor = createCircuitBreakerInterceptor({ threshold, halfOpenAfter: 60_000 });

            const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

            const next = createMockNextError(Code.Internal, "Service error");

            const handler = interceptor(next as any);

            // Exactly `threshold` failures reach the downstream and are passed on as they are
            for (let i = 0; i < threshold; i++) {
                await assert.rejects(
                    () => handler(mockReq),
                    (err: unknown) => {
                        assertConnectError(err, Code.Internal);
                        return true;
                    },
                );
            }

            // The next call is refused by the open circuit without reaching the downstream
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, threshold);
        });
    }

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

    for (const [label, threshold, got] of [
        ["zero", 0, "0"],
        ["negative", -1, "-1"],
        ["infinite", Number.POSITIVE_INFINITY, "Infinity"],
        ["NaN", Number.NaN, "NaN"],
        ["fractional", 2.5, "2.5"],
    ] as const) {
        it(`should refuse a ${label} threshold with a RangeError naming the option and the value`, () => {
            assert.throws(
                () => createCircuitBreakerInterceptor({ threshold }),
                (err: unknown) => err instanceof RangeError && err.message === `createCircuitBreakerInterceptor: threshold must be an integer of at least 1, got ${got}`,
            );
        });
    }

    for (const [label, halfOpenAfter, got] of [
        ["negative", -1, "-1"],
        ["infinite", Number.POSITIVE_INFINITY, "Infinity"],
        ["fractional", 0.5, "0.5"],
        ["NaN", Number.NaN, "NaN"],
        ["above the timer ceiling", 2_147_483_648, "2147483648"],
    ] as const) {
        it(`should refuse a ${label} halfOpenAfter with a RangeError naming the option and the value`, () => {
            assert.throws(
                () => createCircuitBreakerInterceptor({ halfOpenAfter }),
                (err: unknown) =>
                    err instanceof RangeError &&
                    err.message === `createCircuitBreakerInterceptor: halfOpenAfter must be an integer from 0 to 2147483647 milliseconds, got ${got}`,
            );
        });
    }

    it("should refuse non-number threshold and halfOpenAfter with a TypeError", () => {
        assert.throws(
            () => createCircuitBreakerInterceptor({ threshold: "5" as unknown as number }),
            (err: unknown) => err instanceof TypeError && err.message === 'createCircuitBreakerInterceptor: threshold must be an integer of at least 1, got "5"',
        );
        assert.throws(
            () => createCircuitBreakerInterceptor({ halfOpenAfter: null as unknown as number }),
            (err: unknown) =>
                err instanceof TypeError && err.message === "createCircuitBreakerInterceptor: halfOpenAfter must be an integer from 0 to 2147483647 milliseconds, got null",
        );
    });

    it("should accept the boundary values threshold 1, halfOpenAfter 0 and halfOpenAfter 2147483647", () => {
        assert.strictEqual(typeof createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 0 }), "function");
        assert.strictEqual(typeof createCircuitBreakerInterceptor({ halfOpenAfter: 2_147_483_647 }), "function");
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
            // The report of the broken predicate goes to the console; it is captured so
            // the run stays quiet and so the report can be checked to carry the cause.
            const consoleErrorMock = mock.method(console, "error", () => {});
            try {
                const classifierBug = new Error("buggy classifier");
                const interceptor = createCircuitBreakerInterceptor({
                    threshold: 2,
                    halfOpenAfter: 60_000,
                    failurePredicate: () => {
                        throw classifierBug;
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
                assert.strictEqual(next.mock.calls.length, 2, "the third call must be refused without reaching the downstream");
                assert.ok(
                    consoleErrorMock.mock.calls.every((call) => (call.arguments as unknown[]).includes(classifierBug)) && consoleErrorMock.mock.calls.length === 2,
                    "each classification failure must be reported with the predicate's own error",
                );
            } finally {
                consoleErrorMock.mock.restore();
            }
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
            assert.strictEqual(next.mock.calls.length, 4, "the first logical call must make 1 attempt plus 3 retries");

            // Circuit must still be CLOSED: second logical call reaches next again with
            // its own full set of attempts, and is the second counted failure.
            await assert.rejects(() => handler(mockReq));
            assert.strictEqual(next.mock.calls.length, 8, "second logical call must reach next — circuit closed after one logical failure");

            // Two logical failures reached the threshold: the circuit is open now.
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable, "Circuit breaker is open");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 8);
        });
    });
});

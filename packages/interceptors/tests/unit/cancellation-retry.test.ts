import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StringValueSchema } from "@bufbuild/protobuf/wkt";
import type { Interceptor, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Code, ConnectError, createContextValues } from "@connectrpc/connect";
import { createMockRequest } from "@connectum/test-fixtures";
import type { IBackoff, IBackoffFactory, IRetryBackoffContext } from "cockatiel";
import { ExponentialBackoff } from "cockatiel";
import { createRetryInterceptor } from "../../src/retry.ts";

function request(signal = new AbortController().signal): UnaryRequest {
    return { ...createMockRequest(), signal, requestMethod: "POST", contextValues: createContextValues() };
}
function response(req: UnaryRequest): UnaryResponse {
    return { stream: false, service: req.service, method: req.method, message: req.message, header: new Headers(), trailer: new Headers() };
}
const unary =
    (next: (req: UnaryRequest) => Promise<UnaryResponse>): Parameters<Interceptor>[0] =>
    async (req) => {
        assert.equal(req.stream, false);
        return next(req as UnaryRequest);
    };

describe("retry cancellation contract", () => {
    it("never invokes an already cancelled request and preserves its structured reason", async () => {
        const parent = new AbortController();
        const reason = new ConnectError("upstream deadline", Code.DeadlineExceeded, { "x-reason": "deadline" }, [{ desc: StringValueSchema, value: { value: "deadline" } }]);
        parent.abort(reason);
        let calls = 0;
        await assert.rejects(
            createRetryInterceptor()(
                unary(async (req) => {
                    calls++;
                    return response(req);
                }),
            )(request(parent.signal)),
            (error: unknown) => error === reason,
        );
        assert.equal(calls, 0);
        assert.equal(reason.metadata.get("x-reason"), "deadline");
        assert.deepEqual(reason.details, [{ desc: StringValueSchema, value: { value: "deadline" } }]);
    });

    it("interrupts a long backoff and removes its cancellation listener without another attempt", { timeout: 1_000 }, async () => {
        const parent = new AbortController();
        const scheduled = Promise.withResolvers<void>();
        const original = ExponentialBackoff.prototype.next;
        const spy = mock.method(ExponentialBackoff.prototype, "next", function (this: ExponentialBackoff<unknown>) {
            const value = original.call(this);
            scheduled.resolve();
            return value;
        });
        const random = mock.method(Math, "random", () => 0.5);
        const reason = new ConnectError("caller left", Code.Canceled);
        let calls = 0;
        const baseline = getEventListeners(parent.signal, "abort").length;
        try {
            const call = createRetryInterceptor({ initialDelay: 10_000, maxDelay: 10_000 })(async () => {
                calls++;
                throw new ConnectError("unavailable", Code.Unavailable);
            })(request(parent.signal));
            await scheduled.promise;
            assert.ok(getEventListeners(parent.signal, "abort").length > baseline, "the promise timer is actively waiting on cancellation");
            parent.abort(reason);
            await assert.rejects(call, (error: unknown) => error === reason);
            assert.equal(calls, 1);
            assert.equal(getEventListeners(parent.signal, "abort").length, baseline);
        } finally {
            spy.mock.restore();
            random.mock.restore();
        }
    });

    it("checks cancellation triggered while the next delay is being calculated", async () => {
        const parent = new AbortController();
        const reason = new ConnectError("cancelled before timer", Code.Canceled);
        const original = ExponentialBackoff.prototype.next;
        const spy = mock.method(ExponentialBackoff.prototype, "next", function (this: ExponentialBackoff<unknown>) {
            parent.abort(reason);
            return original.call(this);
        });
        let calls = 0;
        try {
            await assert.rejects(
                createRetryInterceptor({ initialDelay: 10_000 })(async () => {
                    calls++;
                    throw new ConnectError("unavailable", Code.Unavailable);
                })(request(parent.signal)),
                (error: unknown) => error === reason,
            );
            assert.equal(calls, 1);
        } finally {
            spy.mock.restore();
        }
    });

    it("does not start another attempt when cancellation arrives as the delay completes", async () => {
        const parent = new AbortController();
        const reason = new ConnectError("cancelled at the delay boundary", Code.Canceled);
        const originalRemove = parent.signal.removeEventListener;
        let completedDelay = false;
        const spy = mock.method(parent.signal, "removeEventListener", function (this: AbortSignal, ...args: Parameters<AbortSignal["removeEventListener"]>) {
            originalRemove.apply(this, args);
            if (args[0] === "abort" && !parent.signal.aborted) {
                // The native promise timer removes its listener before the
                // fulfilled delay resumes the retry loop. Abort in that gap.
                completedDelay = true;
                parent.abort(reason);
            }
        });
        let calls = 0;
        try {
            await assert.rejects(
                createRetryInterceptor({ initialDelay: 0, maxDelay: 0 })(async () => {
                    calls++;
                    throw new ConnectError("unavailable", Code.Unavailable);
                })(request(parent.signal)),
                (error: unknown) => error === reason,
            );
            assert.equal(completedDelay, true, "the timer must finish before this cancellation is injected");
            assert.equal(calls, 1);
        } finally {
            spy.mock.restore();
        }
    });

    for (const outcome of ["success", "failure"] as const) {
        it(`waits for an unaware in-flight ${outcome} and then rejects instead of returning or retrying`, async () => {
            const parent = new AbortController();
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const reason = new ConnectError("caller cancelled active work", Code.Canceled);
            let calls = 0;
            let settled = false;
            let cleanup = 0;
            const call = createRetryInterceptor({ initialDelay: 0 })(
                unary(async (req) => {
                    calls++;
                    entered.resolve();
                    try {
                        await release.promise;
                        if (outcome === "failure") throw new ConnectError("late unavailable", Code.Unavailable);
                        return response(req);
                    } finally {
                        cleanup++;
                    }
                }),
            )(request(parent.signal));
            const result = call.then(
                () => {
                    settled = true;
                    assert.fail("cancelled in-flight work returned a successful retry result");
                },
                (error: unknown) => {
                    settled = true;
                    assert.equal(error, reason);
                },
            );
            await entered.promise;
            parent.abort(reason);
            await delay(5);
            assert.equal(settled, false, "retry must not detach active work from its enclosing bulkhead");
            assert.equal(cleanup, 0);
            release.resolve();
            await result;
            assert.equal(calls, 1);
            assert.equal(cleanup, 1);
        });
    }

    it("maps ordinary caller errors to Canceled after cooperative work finishes", async () => {
        const parent = new AbortController();
        const entered = Promise.withResolvers<void>();
        let cleanup = 0;
        const call = createRetryInterceptor()(
            unary(async (req) => {
                entered.resolve();
                try {
                    await delay(10_000, undefined, { signal: req.signal });
                    return response(req);
                } finally {
                    cleanup++;
                }
            }),
        )(request(parent.signal));
        await entered.promise;
        parent.abort(new Error("caller stopped"));
        await assert.rejects(call, (error: unknown) => error instanceof ConnectError && error.code === Code.Canceled);
        assert.equal(cleanup, 1);
    });

    for (const [budget, expected] of [
        [0, 1],
        [0.5, 2],
        [3, 4],
    ] as const) {
        it(`keeps ${expected} total attempts for the existing retry budget ${budget}`, async () => {
            let calls = 0;
            const error = new ConnectError("unavailable", Code.Unavailable);
            await assert.rejects(
                createRetryInterceptor({ maxRetries: budget, initialDelay: 0, maxDelay: 0 })(async () => {
                    calls++;
                    throw error;
                })(request()),
                (actual: unknown) => actual === error,
            );
            assert.equal(calls, expected);
        });
    }

    for (const error of [new Error("ordinary failure"), new ConnectError("not found", Code.NotFound)]) {
        it(`returns non-retryable ${error.name} unchanged`, async () => {
            let calls = 0;
            await assert.rejects(
                createRetryInterceptor()(async () => {
                    calls++;
                    throw error;
                })(request()),
                (actual: unknown) => actual === error,
            );
            assert.equal(calls, 1);
        });
    }

    it("keeps the configured filter and returns the recovered response by identity", async () => {
        let calls = 0;
        const req = request();
        const recovered = response(req);
        const result = await createRetryInterceptor({ initialDelay: 0, maxDelay: 0, retryableCodes: [Code.NotFound] })(async () => {
            calls++;
            if (calls === 1) throw new ConnectError("temporarily missing", Code.NotFound);
            return recovered;
        })(req);
        assert.equal(calls, 2);
        assert.equal(result, recovered);
    });

    it("preserves public Cockatiel jitter durations, fractional delays and independent concurrent state", async () => {
        const random = mock.method(Math, "random", () => 0.5);
        const original = ExponentialBackoff.prototype.next;
        const durations: number[][] = [];
        const contexts: number[][] = [];
        const options = { initialDelay: 0.5, maxDelay: 1.5 };
        const expected: number[] = [];
        const factory: IBackoffFactory<IRetryBackoffContext<unknown>> = new ExponentialBackoff(options);
        const context: IRetryBackoffContext<unknown> = { attempt: 1, signal: new AbortController().signal, result: { error: new ConnectError("unavailable", Code.Unavailable) } };
        let reference = factory.next(context);
        for (let attempt = 1; attempt <= 3; attempt++) {
            expected.push(reference.duration);
            reference = reference.next({ ...context, attempt: attempt + 1 });
        }
        function observe(value: IBackoff<unknown>, sequence: number[], attempts: number[]): IBackoff<unknown> {
            sequence.push(value.duration);
            return {
                duration: value.duration,
                next: (ctx: unknown) => {
                    attempts.push((ctx as IRetryBackoffContext<unknown>).attempt);
                    return observe(value.next(ctx), sequence, attempts);
                },
            };
        }
        const spy = mock.method(ExponentialBackoff.prototype, "next", function (this: ExponentialBackoff<unknown>) {
            const sequence: number[] = [];
            const attempts = [1];
            durations.push(sequence);
            contexts.push(attempts);
            return observe(original.call(this), sequence, attempts);
        });
        try {
            const interceptor = createRetryInterceptor({ ...options, maxRetries: 3 });
            await Promise.all(
                [1, 2].map(async () => {
                    const error = new ConnectError("unavailable", Code.Unavailable);
                    await assert.rejects(
                        interceptor(async () => {
                            throw error;
                        })(request()),
                        (actual: unknown) => actual === error,
                    );
                }),
            );
            assert.deepEqual(durations, [expected, expected]);
            assert.deepEqual(contexts, [
                [1, 2, 3],
                [1, 2, 3],
            ]);
            assert.ok(expected.every((value) => value <= options.maxDelay));
        } finally {
            spy.mock.restore();
            random.mock.restore();
        }
    });
});

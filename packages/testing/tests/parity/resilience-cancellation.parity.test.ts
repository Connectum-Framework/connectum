import assert from "node:assert/strict";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { StringValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { createRetryInterceptor } from "../../../interceptors/src/retry.ts";
import { createTimeoutInterceptor } from "../../../interceptors/src/timeout.ts";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

async function settlesWithin(settlement: Promise<void>, maxWaitMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            settlement.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), maxWaitMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function describeError(error: unknown): NonNullable<ParityScenarioResult["error"]> {
    assert.ok(error instanceof ConnectError);
    return {
        code: error.code,
        message: error.rawMessage,
        metadata: Object.fromEntries([...error.metadata].filter(([name]) => name.startsWith("x-"))),
        details: error.findDetails(StringValueSchema).map(({ value }) => ({ value })),
    };
}

function expectResult(expected: ParityScenarioResult) {
    return (http: ParityScenarioResult, local: ParityScenarioResult) => {
        assert.deepEqual(http, expected, "HTTP must satisfy the cancellation oracle, rather than merely agree with local");
        assert.deepEqual(local, expected, "local must satisfy the cancellation oracle, rather than merely agree with HTTP");
        defaultCompare(http, local);
    };
}

const deadlineDuration = 40;
function deadlineState() {
    return {
        handlerStarted: Promise.withResolvers<void>(),
        handlerFinished: Promise.withResolvers<void>(),
        outerErrorReady: Promise.withResolvers<void>(),
        releaseOuterError: Promise.withResolvers<void>(),
        fixtureCleanup: new AbortController(),
        handlerSignal: undefined as AbortSignal | undefined,
        cleanupCount: 0,
    };
}
let deadline = deadlineState();

const holdDeadlineError: Interceptor = (next) => async (request) => {
    try {
        return await next(request);
    } catch (error) {
        deadline.outerErrorReady.resolve();
        // Hold the terminal error before transport cleanup can abort the
        // handler. Its earlier abort must come from the timeout interceptor.
        await deadline.releaseOuterError.promise;
        throw error;
    }
};

transportParityTest("timeout propagates its own deadline and cooperative cleanup identically", {
    services: [
        defineService(EchoService, {
            async echo(_request, context) {
                deadline.handlerSignal = context.signal;
                deadline.handlerStarted.resolve();
                try {
                    await delay(10_000, undefined, { signal: AbortSignal.any([context.signal, deadline.fixtureCleanup.signal]) });
                    return create(EchoResponseSchema, { message: "unexpected success", timestamp: 0n });
                } finally {
                    deadline.cleanupCount++;
                    deadline.handlerFinished.resolve();
                }
            },
            secureEcho: () => create(EchoResponseSchema, { message: "unused", timestamp: 0n }),
            rateLimitedEcho: () => create(EchoResponseSchema, { message: "unused", timestamp: 0n }),
        }),
    ],
    interceptors: [holdDeadlineError, createTimeoutInterceptor({ duration: deadlineDuration })],
    scenario: async ({ transport }) => {
        deadline = deadlineState();
        const pending = createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "own deadline" }));
        void pending.catch(() => {});
        try {
            await deadline.handlerStarted.promise;
            await deadline.outerErrorReady.promise;
            assert.equal(
                await settlesWithin(deadline.handlerFinished.promise, 500),
                true,
                "own timeout must finish cooperative work before its terminal error reaches the transport",
            );
            assert.equal(deadline.handlerSignal?.aborted, true);
            assert.ok(deadline.handlerSignal.reason instanceof ConnectError);
            assert.equal(deadline.handlerSignal.reason.code, Code.DeadlineExceeded);
            assert.equal(deadline.handlerSignal.reason.rawMessage, `Request timeout after ${deadlineDuration}ms`);
            assert.equal(deadline.cleanupCount, 1);
            deadline.releaseOuterError.resolve();
            const error = await pending.then(
                () => assert.fail("the timed-out RPC unexpectedly succeeded"),
                (reason: unknown) => reason,
            );
            return { error: describeError(error), response: { handlerAborted: true, cleanupCount: deadline.cleanupCount } };
        } finally {
            deadline.fixtureCleanup.abort();
            deadline.releaseOuterError.resolve();
            await deadline.handlerFinished.promise;
            await pending.catch(() => {});
        }
    },
    compare: expectResult({
        error: { code: Code.DeadlineExceeded, message: `Request timeout after ${deadlineDuration}ms`, metadata: {}, details: [] },
        response: { handlerAborted: true, cleanupCount: 1 },
    }),
});

function retryState() {
    return { firstFailure: Promise.withResolvers<void>(), settled: Promise.withResolvers<void>(), attempts: 0, cleanupCount: 0 };
}
let retry = retryState();
const observeRetryCleanup: Interceptor = (next) => async (request) => {
    try {
        return await next(request);
    } finally {
        retry.cleanupCount++;
        retry.settled.resolve();
    }
};
const observeRetryAttempt: Interceptor = (next) => async (request) => {
    retry.attempts++;
    try {
        return await next(request);
    } catch (error) {
        retry.firstFailure.resolve();
        throw error;
    }
};

transportParityTest("caller cancellation interrupts retry backoff and preserves its structured error identically", {
    services: [
        defineService(EchoService, {
            echo: () => {
                throw new ConnectError("temporary backend failure", Code.Unavailable);
            },
            secureEcho: () => create(EchoResponseSchema, { message: "unused", timestamp: 0n }),
            rateLimitedEcho: () => create(EchoResponseSchema, { message: "unused", timestamp: 0n }),
        }),
    ],
    clientInterceptors: [observeRetryCleanup, createRetryInterceptor({ initialDelay: 2_000, maxDelay: 2_000 }), observeRetryAttempt],
    scenario: async ({ transport }) => {
        retry = retryState();
        const random = mock.method(Math, "random", () => 0.5);
        const caller = new AbortController();
        const reason = new ConnectError("caller stopped retry", Code.Canceled, { "x-caller": "preserved" }, [{ desc: StringValueSchema, value: { value: "caller detail" } }]);
        const pending = createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "retry cancellation" }), { signal: caller.signal });
        void pending.catch(() => {});
        try {
            await retry.firstFailure.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            caller.abort(reason);
            assert.equal(await settlesWithin(retry.settled.promise, 1_000), true, "cancellation must finish retry before its deterministic backoff can expire");
            const error = await pending.then(
                () => assert.fail("the cancelled retry unexpectedly succeeded"),
                (value: unknown) => value,
            );
            assert.equal(retry.attempts, 1);
            assert.equal(retry.cleanupCount, 1);
            return { error: describeError(error), response: { attempts: retry.attempts, cleanupCount: retry.cleanupCount } };
        } finally {
            caller.abort(reason);
            await retry.settled.promise;
            await pending.catch(() => {});
            random.mock.restore();
        }
    },
    compare: expectResult({
        error: { code: Code.Canceled, message: "caller stopped retry", metadata: { "x-caller": "preserved" }, details: [{ value: "caller detail" }] },
        response: { attempts: 1, cleanupCount: 1 },
    }),
});

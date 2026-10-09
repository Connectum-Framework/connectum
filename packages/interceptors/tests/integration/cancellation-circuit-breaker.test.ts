import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createCircuitBreakerInterceptor } from "../../src/circuit-breaker.ts";
import { createRetryInterceptor } from "../../src/retry.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

function deferred<T = void>() {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = (value) => done(value as T);
    });
    return { promise, resolve };
}

// Default chain order: timeout is outside the circuit breaker, which wraps retry.
// Every scenario below runs a request through that exact composition.
function createEchoServer(options: { echo: (message: string, signal: AbortSignal) => Promise<string>; interceptors: Interceptor[] }) {
    return createServer({
        interceptors: options.interceptors,
        services: [
            defineService(EchoService, {
                async echo(request, context) {
                    return create(EchoResponseSchema, { message: await options.echo(request.message, context.signal), timestamp: 0n });
                },
                async secureEcho() {
                    return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                },
                async rateLimitedEcho() {
                    return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                },
            }),
        ],
    });
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

function isCode(code: Code, rawMessage?: string) {
    return (error: unknown) => {
        assert.ok(error instanceof ConnectError, `expected a ConnectError, got ${String(error)}`);
        assert.equal(error.code, code);
        if (rawMessage !== undefined) assert.equal(error.rawMessage, rawMessage);
        return true;
    };
}

// Placed between timeout and circuit breaker. The caller gets its error as soon as the
// client aborts, but the breaker records the outcome only when the inner chain unwinds;
// this observer settles at exactly that moment, so a test can wait for it instead of
// relying on the unwind finishing before the next request is sent.
function observeBreakerSettlement() {
    const firstCallSettled = deferred<void>();
    let calls = 0;
    const interceptor: Interceptor = (next) => async (request) => {
        const callNumber = ++calls;
        try {
            return await next(request);
        } finally {
            if (callNumber === 1) firstCallSettled.resolve();
        }
    };
    return { interceptor, firstCallSettled: firstCallSettled.promise };
}

describe("timeout in front of a circuit breaker", { timeout: 10_000 }, () => {
    it("counts an expired deadline of a cooperative handler as a circuit failure", async () => {
        let handlerCalls = 0;
        const server = createEchoServer({
            interceptors: [
                createTimeoutInterceptor({ duration: 100 }),
                createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 60_000 }),
                createRetryInterceptor({ maxRetries: 0 }),
            ],
            echo: async (_message, signal) => {
                handlerCalls++;
                return await rejectOnAbort(signal);
            },
        });
        const client = createClient(EchoService, createLocalTransport(server));
        try {
            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "one" })), isCode(Code.DeadlineExceeded, "Request timeout after 100ms"));
            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "two" })), isCode(Code.DeadlineExceeded, "Request timeout after 100ms"));
            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "three" })), isCode(Code.Unavailable, "Circuit breaker is open (2 consecutive failures)"));
            assert.equal(handlerCalls, 2, "the open circuit rejects the third request before it reaches the handler");
        } finally {
            if (server.isRunning) await server.stop();
        }
    });

    it("records the failure of a signal-unaware handler only when that handler settles", async () => {
        const firstStarted = deferred<void>();
        const releaseFirst = deferred<void>();
        const firstSettled = deferred<void>();
        let handlerCalls = 0;
        // Sits between timeout and circuit breaker: it settles when the inner chain
        // does, which is the moment the breaker has recorded the outcome.
        const observeInnerSettlement: Interceptor = (next) => async (request) => {
            try {
                return await next(request);
            } finally {
                firstSettled.resolve();
            }
        };
        const server = createEchoServer({
            interceptors: [
                createTimeoutInterceptor({ duration: 100 }),
                observeInnerSettlement,
                createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 60_000 }),
                createRetryInterceptor({ maxRetries: 0 }),
            ],
            echo: async (message) => {
                handlerCalls++;
                if (message === "slow") {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
                return `response:${message}`;
            },
        });
        const client = createClient(EchoService, createLocalTransport(server));
        try {
            const slow = client.echo(create(EchoRequestSchema, { message: "slow" }));
            void slow.catch(() => {});
            await firstStarted.promise;
            await assert.rejects(slow, isCode(Code.DeadlineExceeded, "Request timeout after 100ms"));

            const whileRunning = await client.echo(create(EchoRequestSchema, { message: "while-running" }));
            assert.equal(whileRunning.message, "response:while-running", "the caller already got its deadline error, but the circuit has not recorded a failure yet");
            assert.equal(handlerCalls, 2);

            releaseFirst.resolve();
            await firstSettled.promise;
            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "after-settle" })), isCode(Code.Unavailable, "Circuit breaker is open (1 consecutive failures)"));
            assert.equal(handlerCalls, 2);
        } finally {
            releaseFirst.resolve();
            if (server.isRunning) await server.stop();
        }
    });

    it("does not count caller cancellation as a circuit failure", async () => {
        const started = deferred<void>();
        let handlerCalls = 0;
        const observer = observeBreakerSettlement();
        const server = createEchoServer({
            interceptors: [createTimeoutInterceptor({ duration: 5_000 }), observer.interceptor, createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 60_000 }), createRetryInterceptor({ maxRetries: 0 })],
            echo: async (message, signal) => {
                handlerCalls++;
                if (message === "cancelled") {
                    started.resolve();
                    return await rejectOnAbort(signal);
                }
                return `response:${message}`;
            },
        });
        const client = createClient(EchoService, createLocalTransport(server));
        try {
            const controller = new AbortController();
            const pending = client.echo(create(EchoRequestSchema, { message: "cancelled" }), { signal: controller.signal });
            void pending.catch(() => {});
            await started.promise;
            controller.abort(new ConnectError("caller stopped", Code.Canceled));
            await assert.rejects(pending, isCode(Code.Canceled, "caller stopped"));
            await observer.firstCallSettled;

            const next = await client.echo(create(EchoRequestSchema, { message: "next" }));
            assert.equal(next.message, "response:next", "a cancelled call leaves the circuit closed");
            assert.equal(handlerCalls, 2);
        } finally {
            if (server.isRunning) await server.stop();
        }
    });

    it("counts caller cancellation whose own ConnectError carries an infrastructure code", async () => {
        const started = deferred<void>();
        let handlerCalls = 0;
        const observer = observeBreakerSettlement();
        const server = createEchoServer({
            interceptors: [createTimeoutInterceptor({ duration: 5_000 }), observer.interceptor, createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 60_000 }), createRetryInterceptor({ maxRetries: 0 })],
            echo: async (_message, signal) => {
                handlerCalls++;
                started.resolve();
                return await rejectOnAbort(signal);
            },
        });
        const client = createClient(EchoService, createLocalTransport(server));
        try {
            const controller = new AbortController();
            const pending = client.echo(create(EchoRequestSchema, { message: "cancelled" }), { signal: controller.signal });
            void pending.catch(() => {});
            await started.promise;
            controller.abort(new ConnectError("upstream gone", Code.Unavailable));
            await assert.rejects(pending, isCode(Code.Unavailable, "upstream gone"));
            await observer.firstCallSettled;

            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "next" })), isCode(Code.Unavailable, "Circuit breaker is open (1 consecutive failures)"));
            assert.equal(handlerCalls, 1);
        } finally {
            if (server.isRunning) await server.stop();
        }
    });
});

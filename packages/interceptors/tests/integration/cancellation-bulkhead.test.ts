import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createBulkheadInterceptor } from "../../src/bulkhead.ts";
import { createRetryInterceptor } from "../../src/retry.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

function deferred<T = void>() {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = (value) => done(value as T);
    });
    return { promise, resolve };
}

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

describe("bulkhead cancellation accounting", { timeout: 10_000 }, () => {
    it("holds its only slot until signal-unaware work actually settles", async () => {
        const firstStarted = deferred<void>();
        const firstRelease = deferred<void>();
        const firstSettled = deferred<void>();
        const slotReleased = deferred<void>();
        let interceptedCalls = 0;
        // Outside the bulkhead: settles when the bulkhead has released the slot, which
        // happens after the handler finishes, not when the handler's own finally runs.
        const observeSlotRelease: Interceptor = (next) => async (request) => {
            const callNumber = ++interceptedCalls;
            try {
                return await next(request);
            } finally {
                if (callNumber === 1) slotReleased.resolve();
            }
        };
        let invocations = 0;
        let active = 0;
        const server = createServer({
            interceptors: [
                createTimeoutInterceptor({ duration: 40 }),
                observeSlotRelease,
                createBulkheadInterceptor({ capacity: 1, queueSize: 0 }),
                createRetryInterceptor({ maxRetries: 2, initialDelay: 100, maxDelay: 100 }),
            ],
            services: [
                defineService(EchoService, {
                    async echo(request) {
                        invocations++;
                        active++;
                        if (invocations === 1) {
                            firstStarted.resolve();
                            try {
                                await firstRelease.promise;
                                return create(EchoResponseSchema, { message: "late first response", timestamp: 0n });
                            } finally {
                                active--;
                                firstSettled.resolve();
                            }
                        }
                        active--;
                        return create(EchoResponseSchema, { message: `response:${request.message}`, timestamp: 0n });
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
        const client = createClient(EchoService, createLocalTransport(server));
        try {
            const first = client.echo(create(EchoRequestSchema, { message: "first" }));
            await firstStarted.promise;
            await assert.rejects(first, (error: unknown) => {
                assert.ok(error instanceof ConnectError);
                assert.equal(error.code, Code.DeadlineExceeded);
                return true;
            });

            assert.equal(active, 1, "the timed-out handler is still executing despite the caller error");
            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "blocked" })), (error: unknown) => {
                assert.ok(error instanceof ConnectError);
                assert.equal(error.code, Code.ResourceExhausted);
                return true;
            });
            assert.equal(invocations, 1, "a rejected request must not enter the handler");

            firstRelease.resolve();
            await firstSettled.promise;
            await slotReleased.promise;
            assert.equal(active, 0);
            const response = await client.echo(create(EchoRequestSchema, { message: "after-settle" }));
            assert.deepEqual(response, { $typeName: "echo.v1.EchoResponse", message: "response:after-settle", timestamp: 0n });
            assert.equal(invocations, 2);
        } finally {
            firstRelease.resolve();
            if (server.isRunning) await server.stop();
        }
    });

    it("keeps capacity occupied through cooperative cleanup and releases it once cleanup finishes", async () => {
        const firstStarted = deferred<void>();
        const cleanupStarted = deferred<void>();
        const releaseCleanup = deferred<void>();
        const workSettled = deferred<void>();
        let interceptedCalls = 0;
        let handlerCalls = 0;
        let cleanupCount = 0;
        let firstSignal: AbortSignal | undefined;
        const observeSlotSettlement: Interceptor = (next) => async (request) => {
            const callNumber = ++interceptedCalls;
            try {
                return await next(request);
            } finally {
                if (callNumber === 1) workSettled.resolve();
            }
        };
        const server = createServer({
            interceptors: [
                createTimeoutInterceptor({ duration: 45 }),
                observeSlotSettlement,
                createBulkheadInterceptor({ capacity: 1, queueSize: 0 }),
                createRetryInterceptor({ maxRetries: 2, initialDelay: 100, maxDelay: 100 }),
            ],
            services: [
                defineService(EchoService, {
                    async echo(request, context) {
                        handlerCalls++;
                        if (request.message === "first") {
                            firstSignal = context.signal;
                            firstStarted.resolve();
                            try {
                                await sleep(10_000, undefined, { signal: context.signal });
                                throw new Error("cooperative work unexpectedly completed without cancellation");
                            } finally {
                                cleanupStarted.resolve();
                                await releaseCleanup.promise;
                                cleanupCount++;
                            }
                        }
                        return create(EchoResponseSchema, { message: `response:${request.message}`, timestamp: 0n });
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
        const client = createClient(EchoService, createLocalTransport(server));
        const first = client.echo(create(EchoRequestSchema, { message: "first" }));
        void first.catch(() => {});
        try {
            await firstStarted.promise;
            await assert.rejects(first, (error: unknown) => {
                assert.ok(error instanceof ConnectError);
                assert.equal(error.code, Code.DeadlineExceeded);
                assert.equal(error.rawMessage, "Request timeout after 45ms");
                return true;
            });
            await cleanupStarted.promise;
            assert.equal(firstSignal?.aborted, true);
            assert.equal(cleanupCount, 0);
            await assert.rejects(client.echo(create(EchoRequestSchema, { message: "during-cleanup" })), (error: unknown) => {
                assert.ok(error instanceof ConnectError);
                assert.equal(error.code, Code.ResourceExhausted);
                return true;
            });
            assert.equal(handlerCalls, 1, "cleanup still owns the only slot, so a competing request cannot enter its handler");
            releaseCleanup.resolve();
            await workSettled.promise;
            assert.equal(cleanupCount, 1);
            const response = await client.echo(create(EchoRequestSchema, { message: "after-cleanup" }));
            assert.deepEqual(response, { $typeName: "echo.v1.EchoResponse", message: "response:after-cleanup", timestamp: 0n });
            assert.equal(handlerCalls, 2);
            assert.equal(cleanupCount, 1, "the cancelled handler cleans up exactly once");
        } finally {
            releaseCleanup.resolve();
            await workSettled.promise;
            await first.catch(() => {});
            if (server.isRunning) await server.stop();
        }
    });

    it("releases its slot after cancellation settles a retry backoff", async () => {
        const retryingCallStarted = deferred<void>();
        const retryChainSettled = deferred<void>();
        const random = mock.method(Math, "random", () => 0.5);
        let retryingAttempts = 0;
        const observeRetrySettlement: Interceptor = (next) => async (request) => {
            try {
                return await next(request);
            } finally {
                retryChainSettled.resolve();
            }
        };
        const server = createServer({
            interceptors: [
                createTimeoutInterceptor({ duration: 50 }),
                createBulkheadInterceptor({ capacity: 1, queueSize: 0 }),
                observeRetrySettlement,
                createRetryInterceptor({ maxRetries: 2, initialDelay: 2_000, maxDelay: 2_000 }),
            ],
            services: [
                defineService(EchoService, {
                    async echo(request) {
                        if (request.message === "retrying") {
                            retryingAttempts++;
                            retryingCallStarted.resolve();
                            throw new ConnectError("temporary backend failure", Code.Unavailable);
                        }
                        return create(EchoResponseSchema, { message: `response:${request.message}`, timestamp: 0n });
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
        const client = createClient(EchoService, createLocalTransport(server));
        const pending = client.echo(create(EchoRequestSchema, { message: "retrying" }));
        void pending.catch(() => {});
        try {
            await retryingCallStarted.promise;
            assert.equal(await settlesWithin(retryChainSettled.promise, 1_000), true, "timeout must settle the retry chain before its configured backoff can complete");
            const outcome = await pending.then(
                () => assert.fail("the retrying call unexpectedly succeeded"),
                (error: unknown) => error,
            );
            assert.ok(outcome instanceof ConnectError);
            assert.equal(outcome.code, Code.DeadlineExceeded);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(retryingAttempts, 1, "cancellation during backoff prevents another handler invocation");

            let response;
            try {
                response = await client.echo(create(EchoRequestSchema, { message: "after-retry-settle" }));
            } catch (error) {
                throw new Error(`the post-backoff RPC failed after the retry chain settled: ${String(error)}`, { cause: error });
            }
            assert.deepEqual(response, {
                $typeName: "echo.v1.EchoResponse",
                message: "response:after-retry-settle",
                timestamp: 0n,
            });
        } finally {
            await retryChainSettled.promise;
            await pending.catch(() => {});
            random.mock.restore();
            if (server.isRunning) await server.stop();
        }
    });
});

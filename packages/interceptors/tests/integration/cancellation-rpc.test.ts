import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, defineCatalog, defineService } from "@connectum/core";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createRetryInterceptor } from "../../src/retry.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

type Placement = "client" | "server";
type TransportKind = "local" | "http";

function deferred<T = void>() {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = (value) => done(value as T);
    });
    return { promise, resolve };
}

async function waitForAbort(signal: AbortSignal | undefined, maxWaitMs: number): Promise<boolean> {
    if (!signal) return false;
    if (signal.aborted) return true;
    return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve(true);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(false);
        }, maxWaitMs);
        signal.addEventListener("abort", onAbort, { once: true });
    });
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

/**
 * Waits for a promise, but fails with a diagnostic instead of waiting forever.
 * A handler that never starts (for example because a 45 ms timeout expired
 * before the request reached it) would otherwise leave the whole test, and the
 * server and connection it owns, suspended until the runner gives up.
 */
async function within<T>(promise: Promise<T>, maxWaitMs: number, describeFailure: () => string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(describeFailure())), maxWaitMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// Message of the throw-away call that makes the connection, the server routing
// and the JIT-compiled request path hot before a test starts its short timers.
const WARMUP_MESSAGE = "connection warm-up";

function isWarmupRequest(request: Parameters<ReturnType<Interceptor>>[0]): boolean {
    return !request.stream && (request.message as { message?: unknown }).message === WARMUP_MESSAGE;
}

// The warm-up call must reach the handler without being gated or timed out by
// the interceptors under test, so those interceptors are bypassed for it.
function exemptWarmup(interceptor: Interceptor): Interceptor {
    return (next) => {
        const guarded = interceptor(next);
        return (request) => (isWarmupRequest(request) ? next(request) : guarded(request));
    };
}

declare module "@connectum/core" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/Echo": { request: import("../../../testing/tests/fixtures/echo/v1/echo_pb.ts").EchoRequest; response: EchoResponse };
    }
}

function isError(code: Code, rawMessage?: string) {
    return (error: unknown) => {
        assert.ok(error instanceof ConnectError);
        assert.equal(error.code, code);
        if (rawMessage !== undefined) assert.equal(error.rawMessage, rawMessage);
        assert.deepEqual(error.details, []);
        return true;
    };
}

async function withRpc(
    transportKind: TransportKind,
    placement: Placement,
    interceptors: Interceptor[],
    implementation: Record<string, (request: never, context: never) => unknown>,
    run: (transport: Transport) => Promise<void>,
) {
    const echo = implementation.echo as (request: EchoRequest, context: never) => unknown;
    const server = createServer({
        host: "127.0.0.1",
        port: 0,
        allowHTTP1: false,
        shutdown: { autoShutdown: false, timeout: 100 },
        interceptors: placement === "server" ? interceptors.map(exemptWarmup) : [],
        services: [
            defineService(EchoService, {
                ...implementation,
                echo: (request: EchoRequest, context: never) =>
                    request.message === WARMUP_MESSAGE ? create(EchoResponseSchema, { message: WARMUP_MESSAGE, timestamp: 0n }) : echo(request, context),
            } as never),
        ],
    });
    let session: Http2SessionManager | undefined;
    try {
        let transport: Transport;
        let bareTransport: Transport;
        if (transportKind === "http") {
            await server.start();
            const port = server.address?.port;
            assert.ok(port);
            const baseUrl = `http://127.0.0.1:${port}`;
            session = new Http2SessionManager(baseUrl);
            bareTransport = createGrpcTransport({ baseUrl, sessionManager: session });
            transport = createGrpcTransport({ baseUrl, sessionManager: session, interceptors: placement === "client" ? interceptors : [] });
        } else {
            bareTransport = createLocalTransport(server);
            transport = createLocalTransport(server, { interceptors: placement === "client" ? interceptors : [] });
        }
        // A timer started on a cold connection can expire before the request has
        // left the client, so the handler would never run. Warm the path first;
        // the call shares the connection (http) and the server with the test call.
        await createClient(EchoService, bareTransport).echo(create(EchoRequestSchema, { message: WARMUP_MESSAGE }), { timeoutMs: 5_000 });
        await run(transport);
    } finally {
        session?.abort();
        if (server.isRunning) await server.stop();
    }
}

for (const transportKind of ["local", "http"] as const) {
    for (const placement of ["client", "server"] as const) {
        for (const cancelKind of ["caller", "deadline"] as const) {
            for (const handlerKind of ["aware", "unaware"] as const) {
                describe(`${transportKind} ${placement} timeout, ${cancelKind} cancellation, ${handlerKind} handler`, { timeout: 10_000 }, () => {
                    it("cancels the call with the first cause and waits for signal-unaware work to settle", async () => {
                        const timeout = createTimeoutInterceptor({ duration: 45 });
                        const started = deferred<void>();
                        const settled = deferred<void>();
                        const terminalReached = deferred<void>();
                        const releaseTerminal = deferred<void>();
                        const outerTerminalReached = deferred<void>();
                        const releaseOuterTerminal = deferred<void>();
                        const release = deferred<void>();
                        let observedSignal: AbortSignal | undefined;
                        let outerError: unknown;
                        let pendingSettled = false;
                        let executions = 0;
                        let cleanupCount = 0;
                        let lateEffects = 0;
                        const holdTerminal: Interceptor = (next) => async (request) => {
                            try {
                                const result = await next(request);
                                terminalReached.resolve();
                                await releaseTerminal.promise;
                                return result;
                            } catch (error) {
                                terminalReached.resolve();
                                await releaseTerminal.promise;
                                throw error;
                            }
                        };
                        const holdOuterTerminal: Interceptor = (next) => async (request) => {
                            try {
                                return await next(request);
                            } catch (error) {
                                outerError = error;
                                outerTerminalReached.resolve();
                                await releaseOuterTerminal.promise;
                                throw error;
                            }
                        };
                        const implementation = {
                            echo: async (_request: unknown, context: { signal: AbortSignal }) => {
                                executions++;
                                observedSignal = context.signal;
                                started.resolve();
                                try {
                                    if (handlerKind === "aware") {
                                        await new Promise<void>((_resolve, reject) => {
                                            if (context.signal.aborted) {
                                                reject(context.signal.reason);
                                                return;
                                            }
                                            context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
                                        });
                                    } else {
                                        await release.promise;
                                        lateEffects++;
                                    }
                                    return create(EchoResponseSchema, { message: "late", timestamp: 0n });
                                } finally {
                                    cleanupCount++;
                                    settled.resolve();
                                }
                            },
                            secureEcho: async () => create(EchoResponseSchema, { message: "unused", timestamp: 0n }),
                            rateLimitedEcho: async () => create(EchoResponseSchema, { message: "unused", timestamp: 0n }),
                        };

                        await withRpc(transportKind, placement, [holdOuterTerminal, timeout, holdTerminal], implementation, async (transport) => {
                            try {
                                const client = createClient(EchoService, transport);
                                const controller = new AbortController();
                                const pending = client.echo(create(EchoRequestSchema, { message: "cancel" }), cancelKind === "caller" ? { signal: controller.signal } : undefined);
                                void pending.then(
                                    () => {
                                        pendingSettled = true;
                                    },
                                    () => {
                                        pendingSettled = true;
                                    },
                                );
                                await within(
                                    started.promise,
                                    5_000,
                                    () =>
                                        `the handler did not start within 5000ms (handler executions: ${executions}, caller outcome ${pendingSettled ? "settled" : "pending"}, error seen by the outermost interceptor: ${String(outerError)})`,
                                );
                                if (cancelKind === "caller") {
                                    controller.abort(new ConnectError("caller stopped", Code.Canceled));
                                }

                                if (cancelKind === "deadline") {
                                    assert.equal(await waitForAbort(observedSignal, 250), true, "the timeout must abort downstream work before its terminal result is released");
                                    await outerTerminalReached.promise;
                                    assert.equal(pendingSettled, false, "the gated terminal result has not reached the caller");
                                    assert.equal(observedSignal?.aborted, true);
                                    if (placement === "server") {
                                        const reason = observedSignal?.reason;
                                        assert.ok(reason instanceof ConnectError);
                                        assert.equal(reason.code, Code.DeadlineExceeded);
                                        assert.equal(reason.rawMessage, "Request timeout after 45ms");
                                    }
                                    assert.ok(outerError instanceof ConnectError);
                                    assert.equal(outerError.code, Code.DeadlineExceeded);
                                    assert.equal(outerError.rawMessage, "Request timeout after 45ms");
                                }
                                if (handlerKind === "unaware") {
                                    assert.equal(cleanupCount, 0, "the timed-out call must not release work that ignores its signal");
                                    assert.equal(lateEffects, 0);
                                }
                                releaseOuterTerminal.resolve();
                                const error =
                                    cancelKind === "caller"
                                        ? isError(Code.Canceled, transportKind === "local" || placement === "client" ? "caller stopped" : undefined)
                                        : isError(Code.DeadlineExceeded, "Request timeout after 45ms");
                                await assert.rejects(pending, error);
                                if (handlerKind === "unaware") {
                                    assert.equal(lateEffects, 0, "the caller error does not finish the held signal-unaware work");
                                    release.resolve();
                                }
                                await terminalReached.promise;
                                releaseTerminal.resolve();
                                assert.equal(await waitForAbort(observedSignal, 250), true, "the handler signal must receive cancellation");
                                assert.equal(executions, 1);
                                await settled.promise;
                                assert.equal(cleanupCount, 1);
                                assert.equal(
                                    lateEffects,
                                    handlerKind === "unaware" ? 1 : 0,
                                    "signal-unaware work can commit after the caller error; cancellation does not roll it back",
                                );
                            } finally {
                                release.resolve();
                                releaseTerminal.resolve();
                                releaseOuterTerminal.resolve();
                            }
                        });
                    });
                });
            }
        }
    }
}

for (const transportKind of ["local", "http"] as const) {
    describe(`${transportKind} retry cancellation over RPC`, { timeout: 10_000 }, () => {
        it("stops a real retry backoff after caller cancellation", async () => {
            const firstFailureObserved = deferred<void>();
            const retryChainSettled = deferred<void>();
            let retryAttempts = 0;
            const random = mock.method(Math, "random", () => 0.5);
            const implementation = {
                async echo() {
                    throw new ConnectError("temporary failure", Code.Unavailable);
                },
                async secureEcho() {
                    return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                },
                async rateLimitedEcho() {
                    return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                },
            };
            const observeSettlement: Interceptor = (next) => async (request) => {
                try {
                    return await next(request);
                } finally {
                    retryChainSettled.resolve();
                }
            };
            const spyRetryAttempt: Interceptor = (next) => async (request) => {
                retryAttempts++;
                try {
                    return await next(request);
                } catch (error) {
                    firstFailureObserved.resolve();
                    throw error;
                }
            };

            try {
                await withRpc(
                    transportKind,
                    "client",
                    [observeSettlement, createRetryInterceptor({ maxRetries: 2, initialDelay: 2_000, maxDelay: 2_000 }), spyRetryAttempt],
                    implementation,
                    async (transport) => {
                        const controller = new AbortController();
                        const pending = createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "retry-backoff" }), { signal: controller.signal });
                        void pending.catch(() => {});
                        try {
                            await firstFailureObserved.promise;
                            await sleep(10);
                            controller.abort(new ConnectError("caller stopped", Code.Canceled));
                            assert.equal(await settlesWithin(retryChainSettled.promise, 1_000), true, "retry cancellation must settle before its configured backoff can complete");
                            await assert.rejects(pending, isError(Code.Canceled, "caller stopped"));
                            assert.equal(retryAttempts, 1, "cancellation during backoff must prevent the next retry invocation before transport");
                        } finally {
                            controller.abort();
                            await retryChainSettled.promise;
                            await pending.catch(() => {});
                        }
                    },
                );
            } finally {
                random.mock.restore();
            }
        });
    });
}

describe("catalog call cancellation", { timeout: 10_000 }, () => {
    it("cascades a parent abort into an in-flight catalog call and prevents retries", async () => {
        let childStarted = deferred<void>();
        let childCallSettled = deferred<void>();
        let childAttempts = 0;
        const childSignal: { value: AbortSignal | undefined } = { value: undefined };
        const getChildSignal = () => childSignal.value;
        const server = createServer({
            host: "127.0.0.1",
            port: 0,
            allowHTTP1: false,
            shutdown: { autoShutdown: false, timeout: 100 },
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            outgoingInterceptors: [createRetryInterceptor({ maxRetries: 2, initialDelay: 100, maxDelay: 100 })],
            services: [
                defineService(EchoService, {
                    async echo(_request, context) {
                        childAttempts++;
                        childSignal.value = context.signal;
                        childStarted.resolve();
                        return await new Promise<EchoResponse>((_resolve, reject) => {
                            context.signal.addEventListener("abort", () => reject(new ConnectError("child cancelled", Code.Unavailable)), { once: true });
                        });
                    },
                    async secureEcho(request, context) {
                        try {
                            return await context.call("echo.v1.EchoService/Echo", request);
                        } finally {
                            childCallSettled.resolve();
                        }
                    },
                    async rateLimitedEcho() {
                        return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                    },
                }),
            ],
        });
        let session: Http2SessionManager | undefined;
        try {
            await server.start();
            const port = server.address?.port;
            assert.ok(port);
            const baseUrl = `http://127.0.0.1:${port}`;
            session = new Http2SessionManager(baseUrl);
            const clients = [
                ["local", server.localClient(EchoService)] as const,
                ["http", createClient(EchoService, createGrpcTransport({ baseUrl, sessionManager: session }))] as const,
            ];
            for (const [transportKind, client] of clients) {
                childStarted = deferred<void>();
                childCallSettled = deferred<void>();
                childAttempts = 0;
                childSignal.value = undefined;
                const controller = new AbortController();
                const pending = client.secureEcho(create(EchoRequestSchema, { message: `cascade-${transportKind}` }), { signal: controller.signal });
                await childStarted.promise;
                controller.abort(new ConnectError("parent stopped", Code.Canceled));
                await assert.rejects(pending, isError(Code.Canceled));
                await childCallSettled.promise;
                assert.equal(getChildSignal()?.aborted, true);
                assert.equal(childAttempts, 1);
            }
        } finally {
            session?.abort();
            if (server.isRunning) await server.stop();
        }
    });

    it("uses an explicit child signal instead of the caller's cascading signal", { timeout: 10_000 }, async () => {
        let childStarted = deferred<void>();
        let childAborted = deferred<void>();
        let childCallSettled = deferred<unknown>();
        const override = new AbortController();
        const childSignal: { value: AbortSignal | undefined } = { value: undefined };
        const getChildSignal = () => childSignal.value;
        let childError: unknown;
        const server = createServer({
            host: "127.0.0.1",
            port: 0,
            allowHTTP1: false,
            shutdown: { autoShutdown: false, timeout: 100 },
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            outgoingInterceptors: [createTimeoutInterceptor({ duration: 90 })],
            services: [
                defineService(EchoService, {
                    async echo(_request, context) {
                        childSignal.value = context.signal;
                        childStarted.resolve();
                        return await new Promise<EchoResponse>((_resolve, reject) => {
                            context.signal.addEventListener(
                                "abort",
                                () => {
                                    childAborted.resolve();
                                    reject(context.signal.reason);
                                },
                                { once: true },
                            );
                        });
                    },
                    async secureEcho(request, context) {
                        try {
                            return await context.call("echo.v1.EchoService/Echo", request, { signal: override.signal });
                        } catch (error) {
                            childError = error;
                            childCallSettled.resolve(error);
                            throw error;
                        }
                    },
                    async rateLimitedEcho() {
                        return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                    },
                }),
            ],
        });
        let session: Http2SessionManager | undefined;
        try {
            await server.start();
            const port = server.address?.port;
            assert.ok(port);
            const baseUrl = `http://127.0.0.1:${port}`;
            session = new Http2SessionManager(baseUrl);
            const clients = [
                ["local", server.localClient(EchoService)] as const,
                ["http", createClient(EchoService, createGrpcTransport({ baseUrl, sessionManager: session }))] as const,
            ];
            for (const [transportKind, client] of clients) {
                childStarted = deferred<void>();
                childAborted = deferred<void>();
                childCallSettled = deferred<unknown>();
                childSignal.value = undefined;
                childError = undefined;
                const parent = new AbortController();
                const pending = client.secureEcho(create(EchoRequestSchema, { message: `override-${transportKind}` }), { signal: parent.signal });
                await childStarted.promise;
                parent.abort(new ConnectError("parent stopped", Code.Canceled));
                await assert.rejects(pending, isError(Code.Canceled));
                assert.equal(getChildSignal()?.aborted, false, "the explicit child signal must detach the child from parent cancellation");
                await childAborted.promise;
                await childCallSettled.promise;
                assert.ok(childError instanceof ConnectError, `child cancellation error was ${String(childError)}`);
                assert.equal(childError.code, Code.DeadlineExceeded);
            }
        } finally {
            override.abort();
            session?.abort();
            if (server.isRunning) await server.stop();
        }
    });
});

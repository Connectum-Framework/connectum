import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ContextValues, createClient, createContextKey, type Interceptor, type Transport } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { getAuthContext } from "../../../auth/src/context.ts";
import { createJwtAuthInterceptor } from "../../../auth/src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../../auth/src/testing/test-jwt.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createRetryInterceptor } from "../../src/retry.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

type TransportKind = "local" | "http";

function deferred<T = void>() {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = (value) => done(value as T);
    });
    return { promise, resolve };
}

async function withRpc(transportKind: TransportKind, interceptors: Interceptor[], run: (transport: Transport) => Promise<void>) {
    const server = createServer({
        host: "127.0.0.1",
        port: 0,
        allowHTTP1: false,
        shutdown: { autoShutdown: false, timeout: 100 },
        interceptors,
        services: [
            defineService(EchoService, {
                echo: async (_request, context) => {
                    const auth = getAuthContext();
                    handlerSeedValue = context.values.get(sharedKey);
                    context.values.set(sharedKey, "updated-in-handler");
                    handlerSubject = auth?.subject;
                    handlerRoles = auth?.roles;
                    handlerSignal = context.signal;
                    started.resolve();
                    try {
                        await new Promise<void>((_resolve, reject) => {
                            if (context.signal.aborted) {
                                reject(context.signal.reason);
                                return;
                            }
                            context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
                        });
                        return create(EchoResponseSchema, { message: "unexpected success", timestamp: 0n });
                    } finally {
                        cleanupSubject = getAuthContext()?.subject;
                        cleanupSharedValue = context.values.get(sharedKey);
                        cleanupCount++;
                        cleaned.resolve();
                    }
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
    let session: Http2SessionManager | undefined;
    try {
        let transport: Transport;
        if (transportKind === "http") {
            await server.start();
            const port = server.address?.port;
            assert.ok(port);
            const baseUrl = `http://127.0.0.1:${port}`;
            session = new Http2SessionManager(baseUrl);
            transport = createGrpcTransport({ baseUrl, sessionManager: session });
        } else {
            transport = createLocalTransport(server);
        }
        await run(transport);
    } finally {
        session?.abort();
        if (server.isRunning) await server.stop();
    }
}

const sharedKey = createContextKey("not-set");
let started = deferred<void>();
let cleaned = deferred<void>();
let outerUnwound = deferred<void>();
let handlerSubject: string | undefined;
let handlerRoles: readonly string[] | undefined;
let handlerSignal: AbortSignal | undefined;
let cleanupSubject: string | undefined;
let cleanupSharedValue: string | undefined;
let handlerSeedValue: string | undefined;
let valuesBeforeTimeout: ContextValues | undefined;
let timeoutClonedValues: ContextValues | undefined;
let cleanupCount = 0;

for (const transportKind of ["local", "http"] as const) {
    for (const cancelKind of ["caller", "deadline"] as const) {
        describe(`${transportKind} authenticated RPC ${cancelKind} cancellation`, { timeout: 10_000 }, () => {
            it("preserves ALS and shared context values through timeout cloning and retry unwind", async () => {
                started = deferred<void>();
                cleaned = deferred<void>();
                outerUnwound = deferred<void>();
                handlerSubject = undefined;
                handlerRoles = undefined;
                handlerSignal = undefined;
                cleanupSubject = undefined;
                cleanupSharedValue = undefined;
                handlerSeedValue = undefined;
                valuesBeforeTimeout = undefined;
                timeoutClonedValues = undefined;
                cleanupCount = 0;

                let authAfterUnwind: ReturnType<typeof getAuthContext>;
                const seedAndObserve: Interceptor = (next) => async (request) => {
                    request.contextValues.set(sharedKey, "seeded-by-outer-interceptor");
                    try {
                        return await next(request);
                    } finally {
                        authAfterUnwind = getAuthContext();
                        outerUnwound.resolve();
                    }
                };
                const captureBeforeTimeout: Interceptor = (next) => async (request) => {
                    valuesBeforeTimeout = request.contextValues;
                    return await next(request);
                };
                const captureTimeoutClone: Interceptor = (next) => async (request) => {
                    timeoutClonedValues = request.contextValues;
                    return await next(request);
                };
                const serverInterceptors = [
                    seedAndObserve,
                    createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, claimsMapping: { roles: "roles" } }),
                    captureBeforeTimeout,
                    createTimeoutInterceptor({ duration: 60 }),
                    captureTimeoutClone,
                    createRetryInterceptor({ maxRetries: 2, initialDelay: 10, maxDelay: 10 }),
                ];
                const token = await createTestJwt({ sub: "cancel-user", roles: ["operator"] });
                const headers = new Headers({ authorization: `Bearer ${token}` });
                const controller = new AbortController();
                await withRpc(transportKind, serverInterceptors, async (transport) => {
                    const client = createClient(EchoService, transport);
                    const pending = client.echo(create(EchoRequestSchema, { message: "authenticated-cancellation" }), { signal: controller.signal, headers });
                    await started.promise;
                    assert.equal(handlerSubject, "cancel-user");
                    assert.deepEqual(handlerRoles, ["operator"]);
                    if (cancelKind === "caller") {
                        controller.abort(new ConnectError("caller stopped", Code.Canceled));
                    }

                    await assert.rejects(pending, (error: unknown) => {
                        assert.ok(error instanceof ConnectError);
                        assert.equal(error.code, cancelKind === "caller" ? Code.Canceled : Code.DeadlineExceeded);
                        if (cancelKind === "deadline") assert.equal(error.rawMessage, "Request timeout after 60ms");
                        if (cancelKind === "caller" && transportKind === "local") assert.equal(error.rawMessage, "caller stopped");
                        assert.deepEqual(error.details, []);
                        return true;
                    });
                    await cleaned.promise;
                    await outerUnwound.promise;

                    assert.equal(handlerSignal?.aborted, true);
                    assert.equal(cleanupCount, 1, "retry must not repeat work after cancellation");
                    assert.equal(cleanupSubject, "cancel-user", "JWT ALS remains active during handler cleanup");
                    assert.equal(handlerSeedValue, "seeded-by-outer-interceptor", "the request clone exposes the shared incoming context values");
                    assert.equal(cleanupSharedValue, "updated-in-handler", "the timeout request clone shares context values");
                    assert.equal(authAfterUnwind, undefined, "the auth ALS scope ends after timeout and retry unwind");
                    assert.strictEqual(timeoutClonedValues, valuesBeforeTimeout, "timeout preserves the ContextValues instance across its request clone");
                    assert.equal(timeoutClonedValues?.get(sharedKey), "updated-in-handler");
                    assert.equal(getAuthContext(), undefined);
                });
            });
        });
    }
}

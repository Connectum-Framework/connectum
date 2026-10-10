import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StringValueSchema } from "@bufbuild/protobuf/wkt";
import type { Interceptor, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Code, ConnectError, createContextKey, createContextValues } from "@connectrpc/connect";
import { createMockRequest } from "@connectum/test-fixtures";
import { TaskCancelledError } from "cockatiel";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

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

describe("timeout cancellation contract", () => {
    it("delivers its structured deadline to cooperative work and cleans up once", async () => {
        const req = request();
        let observed: AbortSignal | undefined;
        let cleanup = 0;
        const finished = Promise.withResolvers<void>();
        const call = createTimeoutInterceptor({ duration: 15 })(
            unary(async (inner) => {
                observed = inner.signal;
                try {
                    await delay(10_000, undefined, { signal: inner.signal });
                    return response(inner);
                } finally {
                    cleanup++;
                    finished.resolve();
                }
            }),
        )(req);
        await assert.rejects(call, (error: unknown) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
        await finished.promise;
        assert.equal(observed?.aborted, true);
        assert.ok(observed?.reason instanceof ConnectError);
        assert.equal(observed.reason.code, Code.DeadlineExceeded);
        assert.equal(observed.reason.rawMessage, "Request timeout after 15ms");
        assert.equal(req.signal.aborted, false);
        assert.equal(cleanup, 1);
    });

    it("does not pretend an unaware handler has stopped when the caller receives a deadline", async () => {
        const gate = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        let commits = 0;
        let cleanup = 0;
        const call = createTimeoutInterceptor({ duration: 15 })(
            unary(async (req) => {
                try {
                    await gate.promise;
                    commits++;
                    return response(req);
                } finally {
                    cleanup++;
                    finished.resolve();
                }
            }),
        )(request());
        try {
            await assert.rejects(call, (error: unknown) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
            assert.equal(commits, 0);
            assert.equal(cleanup, 0);
        } finally {
            gate.resolve();
            await finished.promise;
        }
        assert.equal(commits, 1);
        assert.equal(cleanup, 1);
    });

    for (const reason of [undefined, new Error("caller stopped"), "caller stopped"]) {
        it(`maps a caller reason of ${typeof reason} to Canceled and delivers the abort`, async () => {
            const parent = new AbortController();
            const entered = Promise.withResolvers<void>();
            let signal: AbortSignal | undefined;
            const call = createTimeoutInterceptor({ duration: 1_000 })(
                unary(async (req) => {
                    signal = req.signal;
                    entered.resolve();
                    await delay(10_000, undefined, { signal: req.signal });
                    return response(req);
                }),
            )(request(parent.signal));
            await entered.promise;
            parent.abort(reason);
            await assert.rejects(call, (error: unknown) => error instanceof ConnectError && error.code === Code.Canceled);
            assert.equal(signal?.aborted, true);
        });
    }

    it("preserves a caller ConnectError, including identity, metadata and details", async () => {
        const parent = new AbortController();
        const reason = new ConnectError("upstream deadline", Code.DeadlineExceeded, { "x-reason": "upstream" }, [{ desc: StringValueSchema, value: { value: "upstream" } }]);
        const entered = Promise.withResolvers<void>();
        const call = createTimeoutInterceptor({ duration: 1_000 })(
            unary(async (req) => {
                entered.resolve();
                await delay(10_000, undefined, { signal: req.signal });
                return response(req);
            }),
        )(request(parent.signal));
        await entered.promise;
        parent.abort(reason);
        await assert.rejects(call, (error: unknown) => error === reason);
        assert.equal(reason.metadata.get("x-reason"), "upstream");
        assert.deepEqual(reason.details, [{ desc: StringValueSchema, value: { value: "upstream" } }]);
    });

    it("never invokes downstream for an already aborted request", async () => {
        const parent = new AbortController();
        const reason = new ConnectError("cancelled before dispatch", Code.Canceled);
        parent.abort(reason);
        let calls = 0;
        const handler = createTimeoutInterceptor()(
            unary(async (req) => {
                calls++;
                return response(req);
            }),
        );
        await assert.rejects(handler(request(parent.signal)), (error: unknown) => error === reason);
        assert.equal(calls, 0);
    });

    it("keeps its own deadline as the first cause after a later parent abort", async () => {
        const parent = new AbortController();
        const gate = Promise.withResolvers<void>();
        let signal: AbortSignal | undefined;
        const call = createTimeoutInterceptor({ duration: 15 })(
            unary(async (req) => {
                signal = req.signal;
                await gate.promise;
                return response(req);
            }),
        )(request(parent.signal));
        try {
            await assert.rejects(call, (error: unknown) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
            const firstReason: unknown = signal?.reason;
            parent.abort(new ConnectError("late caller", Code.Canceled));
            assert.equal(signal?.reason, firstReason);
            assert.ok(firstReason instanceof ConnectError);
            assert.equal(firstReason.code, Code.DeadlineExceeded);
        } finally {
            gate.resolve();
        }
    });

    it("keeps parent cancellation first when the old deadline later passes", async () => {
        const parent = new AbortController();
        const reason = new ConnectError("early caller", Code.Canceled);
        let signal: AbortSignal | undefined;
        const gate = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const call = createTimeoutInterceptor({ duration: 15 })(
            unary(async (req) => {
                signal = req.signal;
                entered.resolve();
                await gate.promise;
                return response(req);
            }),
        )(request(parent.signal));
        await entered.promise;
        parent.abort(reason);
        try {
            await assert.rejects(call, (error: unknown) => error === reason);
            await delay(30);
            assert.equal(signal?.reason, reason);
        } finally {
            gate.resolve();
        }
    });

    for (const error of [new Error("handler failure"), new TaskCancelledError("handler cancellation"), new ConnectError("handler unavailable", Code.Unavailable)]) {
        it(`preserves an unrelated ${error.name} by identity`, async () => {
            const handler = createTimeoutInterceptor()(async () => {
                throw error;
            });
            await assert.rejects(handler(request()), (actual: unknown) => actual === error);
        });
    }

    it("preserves prototype, descriptors and shared values while replacing a non-configurable signal", async () => {
        const req = request();
        const parent = req.signal;
        const key = createContextKey<string>("initial");
        const symbol = Symbol("private context");
        const prototype = { inherited: "retained" };
        Object.setPrototypeOf(req, prototype);
        Object.defineProperty(req, "signal", { value: parent, configurable: false, writable: false });
        Object.defineProperty(req, "hidden", { value: "retained", enumerable: false, writable: false });
        Object.defineProperty(req, symbol, { get: () => "symbol value", enumerable: false });
        const handler = createTimeoutInterceptor()(
            unary(async (inner) => {
                assert.notEqual(inner, req);
                assert.notEqual(inner.signal, parent);
                assert.equal(Object.getPrototypeOf(inner), prototype);
                assert.deepEqual(Object.getOwnPropertyDescriptor(inner, "hidden"), Object.getOwnPropertyDescriptor(req, "hidden"));
                assert.deepEqual(Object.getOwnPropertyDescriptor(inner, symbol), Object.getOwnPropertyDescriptor(req, symbol));
                for (const field of ["header", "contextValues", "message", "method", "service"] as const) assert.equal(inner[field], req[field]);
                inner.header.set("x-shared", "yes");
                inner.contextValues.set(key, "updated");
                return response(inner);
            }),
        );
        await handler(req);
        assert.equal(req.signal, parent);
        assert.equal(req.header.get("x-shared"), "yes");
        assert.equal(req.contextValues.get(key), "updated");
    });

    it("removes parent listeners and the opening timer after success without aborting downstream", async () => {
        const req = request();
        const listeners = getEventListeners(req.signal, "abort").length;
        let observed: AbortSignal | undefined;
        await createTimeoutInterceptor({ duration: 15 })(
            unary(async (inner) => {
                observed = inner.signal;
                return response(inner);
            }),
        )(req);
        assert.equal(getEventListeners(req.signal, "abort").length, listeners);
        await delay(30);
        assert.equal(observed?.aborted, false);
    });

    it("does not share cancellation reasons between concurrent invocations of one policy", async () => {
        const timeout = createTimeoutInterceptor({ duration: 30 });
        const parent = new AbortController();
        const reason = new ConnectError("only this caller", Code.Canceled);
        const handler = timeout(
            unary(async (req) => {
                await delay(10_000, undefined, { signal: req.signal });
                return response(req);
            }),
        );
        const caller = handler(request(parent.signal));
        const own = handler(request());
        parent.abort(reason);
        await assert.rejects(caller, (error: unknown) => error === reason);
        await assert.rejects(own, (error: unknown) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
    });
});

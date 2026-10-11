// These assertions run in the isolated consumer against installed tarballs.
// Source-only tests cannot detect cancellation code missing from published JS.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { StringValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextValues } from "@connectrpc/connect";
import { createRetryInterceptor, createTimeoutInterceptor } from "@connectum/interceptors";
import { createRetryInterceptor as retrySubpath } from "@connectum/interceptors/retry";
import { createTimeoutInterceptor as timeoutSubpath } from "@connectum/interceptors/timeout";
import { createMockRequest } from "@connectum/test-fixtures";

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function request(signal = new AbortController().signal) {
    return { ...createMockRequest(), signal, contextValues: createContextValues(), requestMethod: "POST" };
}
const response = (req) => ({ stream: false, message: req.message, header: new Headers(), trailer: new Headers(), service: req.service, method: req.method });

test("packed main and subpath exports both propagate a structured own deadline", async () => {
    for (const timeout of [createTimeoutInterceptor, timeoutSubpath]) {
        const req = request();
        const finished = deferred();
        let observed;
        let cleanup = 0;
        const call = timeout({ duration: 15 })(async (inner) => {
            observed = inner.signal;
            try {
                await setTimeout(10_000, undefined, { signal: inner.signal });
                return response(inner);
            } finally {
                cleanup++;
                finished.resolve();
            }
        })(req);
        await assert.rejects(call, (error) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
        await finished.promise;
        assert.equal(observed.aborted, true);
        assert.ok(observed.reason instanceof ConnectError);
        assert.equal(observed.reason.code, Code.DeadlineExceeded);
        assert.equal(req.signal.aborted, false);
        assert.equal(cleanup, 1);
    }
});

test("packed timeout preserves caller error identity, metadata and details", async () => {
    const parent = new AbortController();
    const reason = new ConnectError("caller stopped", Code.Canceled, { "x-caller": "preserved" }, [{ desc: StringValueSchema, value: { value: "caller" } }]);
    const entered = deferred();
    const call = createTimeoutInterceptor({ duration: 1_000 })(async (req) => {
        entered.resolve();
        await setTimeout(10_000, undefined, { signal: req.signal });
        return response(req);
    })(request(parent.signal));
    await entered.promise;
    parent.abort(reason);
    await assert.rejects(call, (error) => error === reason);
    assert.equal(reason.metadata.get("x-caller"), "preserved");
    assert.deepEqual(reason.details, [{ desc: StringValueSchema, value: { value: "caller" } }]);
});

test("packed retry interrupts a long backoff through main and subpath imports", { timeout: 2_000 }, async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
        for (const retry of [createRetryInterceptor, retrySubpath]) {
            const parent = new AbortController();
            let attempts = 0;
            const call = retry({ initialDelay: 10_000, maxDelay: 10_000 })(async () => {
                attempts++;
                throw new ConnectError("unavailable", Code.Unavailable);
            })(request(parent.signal));
            await setImmediate();
            assert.ok(getEventListeners(parent.signal, "abort").length > 0, "backoff timer must be waiting on this signal");
            const reason = new ConnectError("caller stopped backoff", Code.Canceled);
            parent.abort(reason);
            await assert.rejects(call, (error) => error === reason);
            assert.equal(attempts, 1);
            assert.equal(getEventListeners(parent.signal, "abort").length, 0);
        }
    } finally {
        Math.random = originalRandom;
    }
});

test("packed retry keeps active work pending and discards its late success", async () => {
    const parent = new AbortController();
    const release = deferred();
    const entered = deferred();
    const reason = new ConnectError("caller stopped active work", Code.Canceled);
    let settled = false;
    let cleanup = 0;
    const call = createRetryInterceptor()(async (req) => {
        entered.resolve();
        try {
            await release.promise;
            return response(req);
        } finally {
            cleanup++;
        }
    })(request(parent.signal));
    const result = call.then(
        () => {
            settled = true;
            assert.fail("cancelled work returned success");
        },
        (error) => {
            settled = true;
            assert.equal(error, reason);
        },
    );
    await entered.promise;
    parent.abort(reason);
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(cleanup, 0);
    release.resolve();
    await result;
    assert.equal(cleanup, 1);
});

test("packed mock requests contain independent non-aborted signals", () => {
    const first = createMockRequest();
    const second = createMockRequest();
    assert.ok(first.signal instanceof AbortSignal);
    assert.equal(first.signal.aborted, false);
    assert.equal(second.signal.aborted, false);
    assert.notEqual(first.signal, second.signal);
});

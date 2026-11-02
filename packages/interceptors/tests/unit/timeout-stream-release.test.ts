/**
 * What the timeout interceptor leaves on the caller's signal once a stream it let through
 * is finished.
 *
 * With `skipStreaming: false` an opened stream has to keep following the caller's abort,
 * so the interceptor keeps one listener on the caller's signal after it returns. That
 * listener must go as soon as the reader is done with the stream, however it is done:
 * on a signal shared by every call of the application a listener per stream piles up.
 */

import assert from "node:assert";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockRequest } from "@connectum/test-fixtures";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

type Handler = ReturnType<ReturnType<typeof createTimeoutInterceptor>>;

/** The listeners the interceptor holds on the caller's signal. */
const listenersOn = (signal: AbortSignal): number => getEventListeners(signal, "abort").length;

/** A server-stream call whose downstream records the signal it was given and answers with `source`. */
function openStream(options: { source: () => AsyncIterable<unknown>; signal: AbortSignal }) {
    const seen: { signal?: AbortSignal } = {};
    const next = async (req: { signal: AbortSignal }) => {
        seen.signal = req.signal;
        return { stream: true, service: "test.Service", method: "StreamMethod", header: new Headers({ "x-kept": "1" }), trailer: new Headers(), message: options.source() };
    };
    const handler = createTimeoutInterceptor({ duration: 5_000, skipStreaming: false })(next as never) as Handler;
    const req = { ...createMockRequest({ service: "test.Service", method: "StreamMethod", message: {}, stream: true }), signal: options.signal };
    return { call: () => handler(req as never), seen };
}

async function* twoMessages() {
    yield 1;
    yield 2;
}

describe("timeout interceptor: releasing a stream", () => {
    it("follows the caller's signal while the stream is open, then lets go when it is read to the end", async () => {
        const caller = new AbortController();
        const { call } = openStream({ source: twoMessages, signal: caller.signal });
        const response = await call();
        assert.strictEqual(response.stream, true);
        assert.strictEqual(listenersOn(caller.signal), 1, "an opened stream keeps following the caller");

        const received: unknown[] = [];
        for await (const message of response.message as AsyncIterable<unknown>) received.push(message);

        assert.deepStrictEqual(received, [1, 2]);
        assert.strictEqual(listenersOn(caller.signal), 0, "a stream read to the end leaves nothing on the caller's signal");
    });

    it("lets go when the reader closes the stream early", async () => {
        const caller = new AbortController();
        const { call } = openStream({ source: twoMessages, signal: caller.signal });
        const response = await call();

        for await (const _ of response.message as AsyncIterable<unknown>) break;

        assert.strictEqual(listenersOn(caller.signal), 0);
    });

    it("lets go when the reader closes a stream it never started reading", async () => {
        const caller = new AbortController();
        const { call } = openStream({ source: twoMessages, signal: caller.signal });
        const response = await call();

        const iterator = (response.message as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await iterator.return?.();

        assert.strictEqual(listenersOn(caller.signal), 0);
    });

    it("lets go when the stream fails, and the reader sees the original failure", async () => {
        const caller = new AbortController();
        const failure = new ConnectError("boom", Code.Internal);
        const { call } = openStream({
            source: () =>
                (async function* () {
                    yield 1;
                    throw failure;
                })(),
            signal: caller.signal,
        });
        const response = await call();

        await assert.rejects(
            async () => {
                for await (const _ of response.message as AsyncIterable<unknown>);
            },
            (error: unknown) => error === failure,
        );

        assert.strictEqual(listenersOn(caller.signal), 0);
    });

    it("aborts the downstream signal when the stream fails, as the abort that follows a failed read would", async () => {
        const caller = new AbortController();
        const failure = new ConnectError("boom", Code.Internal);
        const { call, seen } = openStream({
            source: () =>
                (async function* () {
                    yield 1;
                    throw failure;
                })(),
            signal: caller.signal,
        });
        const response = await call();
        assert.ok(seen.signal);
        assert.strictEqual(seen.signal.aborted, false);

        await assert.rejects(async () => {
            for await (const _ of response.message as AsyncIterable<unknown>);
        });

        assert.strictEqual(seen.signal.aborted, true);
        assert.ok(seen.signal.reason instanceof ConnectError);
        assert.strictEqual(seen.signal.reason.code, Code.Internal);
        assert.strictEqual(caller.signal.aborted, false, "the caller's own signal is not touched");
    });

    it("keeps following the caller for a stream nobody reads, until the caller's signal aborts", async () => {
        const caller = new AbortController();
        const { call } = openStream({ source: twoMessages, signal: caller.signal });
        await call();

        assert.strictEqual(listenersOn(caller.signal), 1);
        caller.abort();
        assert.strictEqual(listenersOn(caller.signal), 0, "an abort removes the one-shot listener");
    });

    it("passes the caller's abort to the downstream signal with the caller's reason while the stream is open", async () => {
        const caller = new AbortController();
        const { call, seen } = openStream({ source: twoMessages, signal: caller.signal });
        await call();
        assert.ok(seen.signal);
        assert.strictEqual(seen.signal.aborted, false);

        const reason = new Error("shutting down");
        caller.abort(reason);

        assert.strictEqual(seen.signal.aborted, true);
        assert.strictEqual(seen.signal.reason, reason);
    });

    it("stops passing the caller's abort once the stream is finished", async () => {
        const caller = new AbortController();
        const { call, seen } = openStream({ source: twoMessages, signal: caller.signal });
        const response = await call();
        for await (const _ of response.message as AsyncIterable<unknown>);

        caller.abort();

        assert.ok(seen.signal);
        assert.strictEqual(seen.signal.aborted, false, "a finished call is not aborted by a later abort of the shared signal");
    });

    it("returns the other fields of the response untouched", async () => {
        const caller = new AbortController();
        const { call } = openStream({ source: twoMessages, signal: caller.signal });
        const response = await call();

        assert.strictEqual(response.service, "test.Service");
        assert.strictEqual(response.method, "StreamMethod");
        assert.strictEqual(response.header.get("x-kept"), "1");
    });

    it("leaves nothing on the caller's signal after a unary-shaped answer to a streaming call", async () => {
        const caller = new AbortController();
        const next = async () => ({ stream: false, message: { ok: true } });
        const handler = createTimeoutInterceptor({ duration: 5_000, skipStreaming: false })(next as never);
        const req = { ...createMockRequest({ service: "test.Service", method: "ClientStream", message: {}, stream: true }), signal: caller.signal };

        await handler(req as never);

        assert.strictEqual(listenersOn(caller.signal), 0);
    });
});

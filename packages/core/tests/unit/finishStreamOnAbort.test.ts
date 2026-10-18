/**
 * finishStreamOnAbort: unwinding a streaming handler's output iterator when the
 * call's signal aborts.
 *
 * The handler's output is a hand-written iterator whose `return()` is NOT
 * idempotent and records whether it ran while a `next()` was still in flight.
 * A native async generator would hide both defects: the language serialises
 * requests to it and runs its `finally` once on its own.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { StreamRequest, StreamResponse } from "@connectrpc/connect";
import { finishStreamOnAbort } from "../../src/finishStreamOnAbort.ts";

interface Recorder {
    returnCalls: number;
    /** `return()` was called while a `next()` had not settled yet. */
    returnedDuringNext: boolean;
}

/** An iterator whose `next()` settles only when `releaseNext()` is called. */
function makeSource() {
    const recorder: Recorder = { returnCalls: 0, returnedDuringNext: false };
    let nextInFlight = false;
    let release: () => void = () => {};
    const iterator: AsyncIterator<string> = {
        async next() {
            nextInFlight = true;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            nextInFlight = false;
            return { done: false, value: "item" };
        },
        async return() {
            recorder.returnCalls++;
            if (nextInFlight) {
                recorder.returnedDuringNext = true;
            }
            return { done: true, value: undefined };
        },
    };
    return {
        recorder,
        iterable: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string>,
        releaseNext: () => release(),
    };
}

/** Run the interceptor over a fake handler whose streamed output is `iterable`. */
async function wrap(iterable: AsyncIterable<string>, signal: AbortSignal): Promise<AsyncIterator<string>> {
    const next = async () => ({ stream: true, message: iterable }) as unknown as StreamResponse;
    const wrapped = await (finishStreamOnAbort(next as never) as (req: StreamRequest) => Promise<StreamResponse>)({ signal } as unknown as StreamRequest);
    return (wrapped.message as AsyncIterable<string>)[Symbol.asyncIterator]();
}

/** Let queued microtasks and the abort listener run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("finishStreamOnAbort", () => {
    it("is an interceptor that leaves a unary response untouched", async () => {
        const unary = { stream: false, message: {} } as never;
        const result = await (finishStreamOnAbort((async () => unary) as never) as unknown as (req: unknown) => Promise<unknown>)({ signal: new AbortController().signal });
        assert.strictEqual(result, unary);
    });

    it("finishes the iterator right away when the abort arrives while the handler is parked", async () => {
        const source = makeSource();
        const abort = new AbortController();
        await wrap(source.iterable, abort.signal);

        abort.abort();
        await settle();

        assert.strictEqual(source.recorder.returnCalls, 1);
    });

    it("finishes the iterator when the call was already aborted before it was opened", async () => {
        const source = makeSource();
        const abort = new AbortController();
        abort.abort();
        await wrap(source.iterable, abort.signal);
        await settle();

        assert.strictEqual(source.recorder.returnCalls, 1);
    });

    it("waits for a pending next() to settle before finishing, never concurrently, and finishes exactly once", async () => {
        const source = makeSource();
        const abort = new AbortController();
        const iterator = await wrap(source.iterable, abort.signal);

        const pending = iterator.next();
        await settle();
        abort.abort();
        await settle();
        assert.strictEqual(source.recorder.returnCalls, 0, "the iterator must not be finished while next() is in flight");

        source.releaseNext();
        await pending;
        await settle();
        assert.strictEqual(source.recorder.returnCalls, 1, "finished once the pending next() settled");
        assert.strictEqual(source.recorder.returnedDuringNext, false);

        // Consumer-side return() and a repeated abort must not finish it a second time.
        await iterator.return?.();
        abort.abort();
        await settle();
        assert.strictEqual(source.recorder.returnCalls, 1);
    });

    it("does not finish a second time when the consumer calls return() after the abort", async () => {
        const source = makeSource();
        const abort = new AbortController();
        const iterator = await wrap(source.iterable, abort.signal);

        abort.abort();
        await settle();
        await iterator.return?.();
        await iterator.return?.();

        assert.strictEqual(source.recorder.returnCalls, 1);
    });
});

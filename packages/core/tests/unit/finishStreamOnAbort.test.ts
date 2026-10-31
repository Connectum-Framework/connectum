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
import { Code, ConnectError, type StreamRequest, type StreamResponse } from "@connectrpc/connect";
import { createShutdownReason, finishStreamOnAbort } from "../../src/finishStreamOnAbort.ts";

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

    // When whoever pumps the stream stops reading (a failed write, a completed
    // response) it calls return(), and by the async iterator protocol the source must be
    // finished then, abort or no abort; a later abort must not finish it again.
    it("finishes the iterator when the consumer calls return() without any abort, and a later abort does not repeat it", async () => {
        const source = makeSource();
        const abort = new AbortController();
        const iterator = await wrap(source.iterable, abort.signal);

        await iterator.return?.();
        assert.strictEqual(source.recorder.returnCalls, 1);

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

/** A finite source: `next()` hands out the given items at once, then reports the end. */
function makeFiniteSource(items: string[]) {
    let index = 0;
    const iterator: AsyncIterator<string> = {
        async next() {
            return index < items.length ? { done: false, value: items[index++] as string } : { done: true, value: undefined };
        },
        async return() {
            index = items.length;
            return { done: true, value: undefined };
        },
    };
    return { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string>;
}

/** The error a read of `iterator` rejects with, or `undefined` when it resolves. */
async function readError(iterator: AsyncIterator<string>): Promise<ConnectError | undefined> {
    try {
        await iterator.next();
    } catch (err) {
        return ConnectError.from(err);
    }
    return undefined;
}

// A stream the interceptor had to cut must not look like a handler that finished: the
// response iterable would end normally and the transport would write a successful end
// of stream for a message list that is incomplete.
describe("finishStreamOnAbort: the read after a cut fails", () => {
    it("reports unavailable when the abort reason is the one server.stop() uses", async () => {
        const source = makeSource();
        const abort = new AbortController();
        const iterator = await wrap(source.iterable, abort.signal);

        abort.abort(createShutdownReason());
        await settle();

        const error = await readError(iterator);
        assert.ok(error, "the read after the cut must fail instead of reporting the end of the stream");
        assert.strictEqual(error.code, Code.Unavailable);
        assert.match(error.rawMessage, /shutting down/);
    });

    it("reports canceled when the client aborted, and for an abort without a reason", async () => {
        for (const reason of [undefined, "gone", new Error("client went away")]) {
            const abort = new AbortController();
            const iterator = await wrap(makeSource().iterable, abort.signal);
            abort.abort(reason);
            await settle();
            const error = await readError(iterator);
            assert.strictEqual(error?.code, Code.Canceled, `reason ${String(reason)}`);
        }
    });

    it("passes a ConnectError reason through, so a deadline stays deadline_exceeded", async () => {
        const abort = new AbortController();
        const iterator = await wrap(makeSource().iterable, abort.signal);
        const deadline = new ConnectError("the operation timed out", Code.DeadlineExceeded);

        abort.abort(deadline);
        await settle();

        const error = await readError(iterator);
        assert.strictEqual(error, deadline);
    });

    it("an abort that arrives while the handler is inside next() still delivers that message, then fails the next read", async () => {
        const source = makeSource();
        const abort = new AbortController();
        const iterator = await wrap(source.iterable, abort.signal);

        const pending = iterator.next();
        await settle();
        abort.abort(createShutdownReason());
        source.releaseNext();

        assert.deepStrictEqual(await pending, { done: false, value: "item" }, "the message the handler already produced is not lost");
        await settle();
        assert.strictEqual((await readError(iterator))?.code, Code.Unavailable);
        assert.strictEqual(source.recorder.returnCalls, 1);
    });

    it("keeps failing every later read with the same error", async () => {
        const abort = new AbortController();
        const iterator = await wrap(makeSource().iterable, abort.signal);
        abort.abort(createShutdownReason());
        await settle();
        const first = await readError(iterator);
        const second = await readError(iterator);
        assert.strictEqual(first?.code, Code.Unavailable);
        assert.strictEqual(second, first);
    });

    it("does not report the cut before the handler's asynchronous cleanup has finished", async () => {
        // The handler's `finally` releases a resource asynchronously. The failing read must wait for it:
        // the transport closes the request when the read fails, and graceful shutdown moves on to the
        // shutdown hooks once the requests are closed, which would close that resource under the handler.
        let finishCleanup: () => void = () => {};
        let cleanupFinished = false;
        const iterator: AsyncIterator<string> = {
            async next() {
                return { done: false, value: "item" };
            },
            async return() {
                await new Promise<void>((resolve) => {
                    finishCleanup = resolve;
                });
                cleanupFinished = true;
                return { done: true, value: undefined };
            },
        };
        const abort = new AbortController();
        const wrapped = await wrap({ [Symbol.asyncIterator]: () => iterator }, abort.signal);

        abort.abort(createShutdownReason());
        await settle();

        let readSettled = false;
        const read = readError(wrapped).then((error) => {
            readSettled = true;
            return error;
        });
        await settle();
        assert.strictEqual(readSettled, false, "the read must wait while the handler's cleanup is running");

        finishCleanup();
        const error = await read;
        assert.strictEqual(cleanupFinished, true);
        assert.strictEqual(error?.code, Code.Unavailable);
    });

    it("does not fail a handler that ended by itself, even when the abort comes right after", async () => {
        const abort = new AbortController();
        const iterator = await wrap(makeFiniteSource(["a"]), abort.signal);

        assert.deepStrictEqual(await iterator.next(), { done: false, value: "a" });
        assert.deepStrictEqual(await iterator.next(), { done: true, value: undefined });

        abort.abort(createShutdownReason());
        await settle();
        assert.deepStrictEqual(await iterator.next(), { done: true, value: undefined }, "a finished stream stays finished, not cut");
    });

    it("does not fail a handler that ends by itself while the abort is arriving", async () => {
        const abort = new AbortController();
        const source: AsyncIterable<string> = {
            [Symbol.asyncIterator]: () => ({
                async next() {
                    abort.abort(createShutdownReason());
                    return { done: true, value: undefined };
                },
            }),
        };
        const iterator = await wrap(source, abort.signal);

        assert.deepStrictEqual(await iterator.next(), { done: true, value: undefined });
        await settle();
        assert.deepStrictEqual(await iterator.next(), { done: true, value: undefined });
    });

    it("does not fail a consumer that stops reading with return(), before or after the abort", async () => {
        const abort = new AbortController();
        const iterator = await wrap(makeFiniteSource(["a"]), abort.signal);
        assert.deepStrictEqual(await iterator.return?.(), { done: true, value: undefined });
        abort.abort(createShutdownReason());
        await settle();
        assert.strictEqual(await readError(iterator), undefined, "the consumer left on its own: nothing to report");
    });

    it("createShutdownReason() is an AbortError, so a handler that rethrows it is still reported as canceled", () => {
        const reason = createShutdownReason();
        assert.strictEqual(reason.name, "AbortError");
        assert.strictEqual(ConnectError.from(reason).code, Code.Canceled);
        assert.notStrictEqual(createShutdownReason(), reason, "every call makes its own marker");
    });
});

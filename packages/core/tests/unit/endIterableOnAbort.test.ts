/**
 * endIterableOnAbort: ending the request stream of an in-process
 * client-streaming or bidirectional call when the call is cancelled.
 *
 * The caller's iterable is a hand-written iterator whose `next()` can park
 * forever (a request stream that stays open and empty) and whose `return()`
 * records whether it ran while a read was still pending.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { endIterableOnAbort } from "../../src/endIterableOnAbort.ts";

function makeCaller() {
    const seen = { returnCalls: 0, returnedDuringNext: false };
    let nextInFlight = false;
    let deliver: (value: IteratorResult<string>) => void = () => {};
    const iterator: AsyncIterator<string> = {
        next() {
            nextInFlight = true;
            return new Promise<IteratorResult<string>>((resolve) => {
                deliver = (value) => {
                    nextInFlight = false;
                    resolve(value);
                };
            });
        },
        async return() {
            seen.returnCalls++;
            if (nextInFlight) {
                seen.returnedDuringNext = true;
            }
            return { done: true, value: undefined };
        },
    };
    return { seen, iterable: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string>, deliver: (value: IteratorResult<string>) => deliver(value) };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("endIterableOnAbort", () => {
    it("passes messages through while the signal is live", async () => {
        const caller = makeCaller();
        const reads = endIterableOnAbort(caller.iterable, new AbortController().signal)[Symbol.asyncIterator]();
        const pending = reads.next();
        caller.deliver({ done: false, value: "a" });
        assert.deepStrictEqual(await pending, { done: false, value: "a" });
        assert.strictEqual(caller.seen.returnCalls, 0);
    });

    it("ends a read parked on the caller's iterator when the signal aborts, and finishes the iterator only after that read settles", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();

        const pending = reads.next();
        await settle();
        abort.abort();

        assert.deepStrictEqual(await pending, { done: true, value: undefined }, "the handler's wait for the next message ends");
        await settle();
        assert.strictEqual(caller.seen.returnCalls, 0, "return() waits for the pending read, it never runs concurrently with it");

        caller.deliver({ done: true, value: undefined });
        await settle();
        assert.strictEqual(caller.seen.returnCalls, 1);
        assert.strictEqual(caller.seen.returnedDuringNext, false);
    });

    it("finishes the caller's iterator right away when no read is pending at the abort, and only once", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();

        abort.abort();
        await settle();
        assert.strictEqual(caller.seen.returnCalls, 1);

        assert.deepStrictEqual(await reads.next(), { done: true, value: undefined }, "a read after the abort reports the end");
        abort.abort();
        await settle();
        assert.strictEqual(caller.seen.returnCalls, 1);
    });

    it("ends the first read when the signal was already aborted", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        abort.abort();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();
        assert.deepStrictEqual(await reads.next(), { done: true, value: undefined });
    });

    it("drops an error from the caller's return(): nobody is left to receive it", async () => {
        const failing: AsyncIterable<string> = {
            [Symbol.asyncIterator]: () => ({
                next: () => new Promise<IteratorResult<string>>(() => {}),
                return: () => Promise.reject(new Error("finally of the caller's generator failed")),
            }),
        };
        const abort = new AbortController();
        const reads = endIterableOnAbort(failing, abort.signal)[Symbol.asyncIterator]();
        abort.abort();
        await settle();
        assert.deepStrictEqual(await reads.next(), { done: true, value: undefined });
    });

    it("does not finish the caller's iterator again after the handler ended the loop itself", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();

        await reads.return?.();
        assert.strictEqual(caller.seen.returnCalls, 1);
        abort.abort();
        await settle();
        assert.strictEqual(caller.seen.returnCalls, 1, "the handler's own return() is the only one");
    });

    it("finishes the caller's iterator once when the consumer's return() follows an abort with a read still pending", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();

        const pending = reads.next();
        await settle();
        abort.abort();
        assert.deepStrictEqual(await pending, { done: true, value: undefined });
        await reads.return?.();
        caller.deliver({ done: true, value: undefined });
        await settle();

        assert.strictEqual(caller.seen.returnCalls, 1, "the abort's scheduled close and the consumer's return() finish the source once");
        assert.strictEqual(caller.seen.returnedDuringNext, false, "the consumer's return() does not overtake the pending read");
    });

    it("ends a read when the caller's own next() aborts the signal and then stays pending", async () => {
        const abort = new AbortController();
        let returns = 0;
        const source: AsyncIterable<string> = {
            [Symbol.asyncIterator]: () => ({
                next: () => {
                    abort.abort();
                    return new Promise<IteratorResult<string>>(() => {});
                },
                return: async () => {
                    returns++;
                    return { done: true, value: undefined };
                },
            }),
        };
        const reads = endIterableOnAbort(source, abort.signal)[Symbol.asyncIterator]();
        assert.deepStrictEqual(await reads.next(), { done: true, value: undefined });
        await settle();
        assert.strictEqual(returns, 0, "the source read is still pending, so the close waits for it");
    });

    it("serves many sequential reads and still ends a parked read on abort", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();

        for (let i = 0; i < 500; i++) {
            const read = reads.next();
            caller.deliver({ done: false, value: `m${i}` });
            assert.deepStrictEqual(await read, { done: false, value: `m${i}` });
        }
        const parked = reads.next();
        abort.abort();
        assert.deepStrictEqual(await parked, { done: true, value: undefined });
    });

    it("does not touch the caller's iterator when the input ended before the abort", async () => {
        const caller = makeCaller();
        const abort = new AbortController();
        const reads = endIterableOnAbort(caller.iterable, abort.signal)[Symbol.asyncIterator]();
        const pending = reads.next();
        caller.deliver({ done: true, value: undefined });
        assert.deepStrictEqual(await pending, { done: true, value: undefined });

        abort.abort();
        await settle();
        assert.strictEqual(caller.seen.returnCalls, 0, "a finished input needs no return()");
    });
});

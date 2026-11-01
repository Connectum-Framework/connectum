/**
 * Ends an async iterable when a signal aborts.
 *
 * @module endIterableOnAbort
 */

/**
 * Wrap `source` so that it reports its end as soon as `signal` aborts.
 *
 * Used for the request stream of an in-process client-streaming or
 * bidirectional call. Over HTTP/2 a cancelled call closes the request body, so
 * a handler parked in `for await (const message of requests)` sees the input end
 * and leaves its loop. In-process the handler reads the caller's own iterable
 * directly and nothing closes it: a handler waiting for the next message stayed
 * suspended after the call was cancelled and its `finally` never ran.
 *
 * A read that is pending at the abort, and every read after it, reports the end
 * of the input; the read of `source` itself may never settle, so it is
 * abandoned. `source` is then finished with `return()`; if its read is still
 * pending, that happens right after the read settles, never concurrently with it.
 * Errors from that `return()` have no recipient (the call is already over) and
 * are dropped.
 *
 * The signal must be the one that says the call is dead (the caller's own signal
 * and deadline). It must not be the server's shutdown signal: `server.stop()`
 * does not end an in-process call, and an upload that merely stops would pass for
 * a complete one.
 *
 * @internal
 */
export function endIterableOnAbort<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]() {
            const iterator = source[Symbol.asyncIterator]();
            // Resolves when the signal aborts, so a read parked in `source` can be abandoned.
            const aborted = Promise.withResolvers<IteratorResult<T>>();
            let pending: Promise<unknown> | undefined;
            let finished = false;

            const finish = (): void => {
                if (finished) {
                    return;
                }
                finished = true;
                signal.removeEventListener("abort", onAbort);
                const close = (): void => {
                    void Promise.resolve()
                        .then(() => iterator.return?.())
                        .catch(() => {});
                };
                if (pending) {
                    void pending.then(close, close);
                } else {
                    close();
                }
            };

            const onAbort = (): void => {
                aborted.resolve({ done: true, value: undefined });
                finish();
            };

            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }

            const result: AsyncIterator<T> = {
                async next(...args: [] | [undefined]) {
                    if (finished) {
                        return { done: true, value: undefined };
                    }
                    const read = iterator.next(...args);
                    pending = read;
                    try {
                        const step = await Promise.race([read, aborted.promise]);
                        if (step.done) {
                            finished = true;
                            signal.removeEventListener("abort", onAbort);
                        }
                        return step;
                    } finally {
                        if (pending === read) {
                            pending = undefined;
                        }
                    }
                },
            };
            if (iterator.return) {
                const forward = iterator.return;
                result.return = (...args: [] | [unknown]) => {
                    finished = true;
                    signal.removeEventListener("abort", onAbort);
                    return forward.apply(iterator, args);
                };
            }
            if (iterator.throw) {
                const forward = iterator.throw;
                result.throw = (...args: [] | [unknown]) => {
                    finished = true;
                    signal.removeEventListener("abort", onAbort);
                    return forward.apply(iterator, args);
                };
            }
            return result;
        },
    };
}

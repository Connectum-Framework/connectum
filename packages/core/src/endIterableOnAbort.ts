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
            // One entry per read in flight: resolves it when the signal aborts, so a read parked in
            // `source` can be abandoned. A read removes its entry when it settles, so a long call does
            // not accumulate a handler per message.
            const waiters = new Set<(step: IteratorResult<T>) => void>();
            let pending: Promise<unknown> | undefined;
            let finished = false;
            // Set once `source.return()` is called or scheduled, so it is called at most once.
            let closed = false;

            const finish = (): void => {
                if (finished) {
                    return;
                }
                finished = true;
                signal.removeEventListener("abort", onAbort);
                const runClose = (): void => {
                    closed = true;
                    void Promise.resolve()
                        .then(() => iterator.return?.())
                        .catch(() => {});
                };
                if (pending) {
                    // Scheduled, not yet run: a consumer's return() meanwhile must not reach the source.
                    closed = true;
                    void pending.then(runClose, runClose);
                } else {
                    runClose();
                }
            };

            const onAbort = (): void => {
                for (const resolve of waiters) {
                    resolve({ done: true, value: undefined });
                }
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
                    // The waiter and the pending marker exist before the caller's code runs, so an abort
                    // raised from inside `source.next()` itself is not missed and the close still waits.
                    const settled = Promise.withResolvers<void>();
                    pending = settled.promise;
                    let release: (step: IteratorResult<T>) => void = () => {};
                    const aborted = new Promise<IteratorResult<T>>((resolve) => {
                        release = resolve;
                        waiters.add(resolve);
                    });
                    try {
                        let read: Promise<IteratorResult<T>>;
                        try {
                            read = Promise.resolve(iterator.next(...args));
                        } catch (error) {
                            read = Promise.reject(error);
                        }
                        const markSettled = (): void => settled.resolve();
                        read.then(markSettled, markSettled);
                        const step = await Promise.race([read, aborted]);
                        if (step.done) {
                            finished = true;
                            signal.removeEventListener("abort", onAbort);
                        }
                        return step;
                    } finally {
                        waiters.delete(release);
                        if (pending === settled.promise) {
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
                    if (closed) {
                        // The abort already scheduled the close; the source is finished exactly once.
                        return Promise.resolve({ done: true, value: args[0] } as IteratorResult<T>);
                    }
                    closed = true;
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

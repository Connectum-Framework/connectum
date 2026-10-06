/**
 * Server interceptor that unwinds a streaming handler when its call is cancelled.
 *
 * Over HTTP/2 the server pumps the handler's output generator into the socket,
 * so a cancelled call breaks the write and the generator unwinds through its
 * `finally`. The in-process transport has no socket: the client is the only
 * consumer, and once it stops pulling, a generator suspended at `yield` never
 * resumes. Its context signal aborts, but the handler cannot react to a signal
 * it is not running to observe, so cursors, subscriptions and handles opened
 * before the `yield` leak. This interceptor closes that gap by finishing the
 * handler's output iterator when the call's signal aborts (client abort,
 * deadline, server shutdown).
 *
 * @module finishStreamOnAbort
 */

import type { Interceptor, StreamResponse } from "@connectrpc/connect";

/**
 * Finishes the handler's output iterator when the call's signal aborts.
 *
 * If the handler is inside a `next()` at that moment, the iterator is finished
 * right after that `next()` settles, never concurrently with it. Errors thrown
 * by the handler's `finally` are dropped: the client has already been told the
 * call was cancelled and there is no other recipient.
 *
 * Must be the interceptor closest to the handler so that other interceptors
 * observe the handler's own response stream.
 *
 * @internal
 */
export const finishStreamOnAbort: Interceptor = (next) => async (req) => {
    const res = await next(req);
    if (!res.stream) {
        return res;
    }
    const streamResponse: StreamResponse = res;
    const source = streamResponse.message;

    return {
        ...streamResponse,
        message: {
            [Symbol.asyncIterator]() {
                const iterator = source[Symbol.asyncIterator]();
                let pulling = false;
                let finished = false;

                const finish = async (): Promise<void> => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    req.signal.removeEventListener("abort", onAbort);
                    try {
                        await iterator.return?.();
                    } catch {
                        // see the interceptor documentation: nobody is left to receive this error
                    }
                };

                const onAbort = (): void => {
                    if (!pulling) {
                        void finish();
                    }
                };

                if (req.signal.aborted) {
                    void finish();
                } else {
                    req.signal.addEventListener("abort", onAbort, { once: true });
                }

                return {
                    async next() {
                        pulling = true;
                        try {
                            const result = await iterator.next();
                            if (result.done) {
                                finished = true;
                                req.signal.removeEventListener("abort", onAbort);
                            }
                            return result;
                        } finally {
                            pulling = false;
                            if (req.signal.aborted) {
                                void finish();
                            }
                        }
                    },
                    async return(value?: unknown) {
                        await finish();
                        return { done: true, value };
                    },
                    async throw(error?: unknown) {
                        finished = true;
                        req.signal.removeEventListener("abort", onAbort);
                        if (iterator.throw === undefined) {
                            throw error;
                        }
                        return await iterator.throw(error);
                    },
                };
            },
        },
    };
};

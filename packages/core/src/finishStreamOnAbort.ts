/**
 * Server interceptor that unwinds a streaming handler when its call is cancelled.
 *
 * A streaming handler's output generator is only unwound when something pulls
 * it again. Over HTTP/2 the server pumps it into the socket, so a cancelled
 * call unwinds it only if the failed socket write is noticed, and that depends
 * on the runtime: a write to a closed stream can still report success, leaving
 * the pump spinning or parked. The in-process transport has no socket at all:
 * the client is the only consumer, and once it stops pulling, a generator
 * suspended at `yield` never resumes. In both cases the context signal aborts,
 * but a handler parked at `yield` cannot react to a signal it is not running to
 * observe, so cursors, subscriptions and handles opened before the `yield`
 * leak. This interceptor closes that gap on both transports by finishing the
 * handler's output iterator when the call's signal aborts (client abort,
 * deadline, server shutdown).
 *
 * Finishing the iterator must not look like the handler completing: a response
 * that ends normally tells the client the list of messages is complete, and a
 * stream cut by a server stop or a deadline is not. After such a cut the next
 * read of the response fails with the error that explains it.
 *
 * @module finishStreamOnAbort
 */

import { AsyncResource } from "node:async_hooks";
import { Code, ConnectError, type Interceptor, type StreamResponse } from "@connectrpc/connect";

/**
 * Abort reasons produced by `server.stop()`. The reason object itself is the
 * marker: a call's signal carries the shutdown signal's reason unchanged, so
 * the identity survives the trip through the framework and cannot be forged by
 * a client abort or a deadline.
 */
const shutdownReasons = new WeakSet<object>();

/**
 * Create the reason `server.stop()` aborts the shutdown signal with.
 *
 * It is an `AbortError` exactly like the one a bare `abort()` produces, so a
 * handler that rethrows it is still reported as `canceled`; the framework only
 * recognises it to end a stream it had to cut with `unavailable`.
 *
 * @internal
 */
export function createShutdownReason(): DOMException {
    const reason = new DOMException("This operation was aborted", "AbortError");
    shutdownReasons.add(reason);
    return reason;
}

/**
 * The error a stream that was cut short reports on its next read.
 *
 * - server stop: `unavailable`, the call can be retried against another instance;
 * - a `ConnectError` reason (a deadline): that error as is;
 * - anything else (the client aborted): `canceled`.
 */
function cutStreamError(reason: unknown): ConnectError {
    if (typeof reason === "object" && reason !== null && shutdownReasons.has(reason)) {
        return new ConnectError("the server is shutting down", Code.Unavailable, undefined, undefined, reason);
    }
    return ConnectError.from(reason, Code.Canceled);
}

/**
 * Finishes the handler's output iterator when the call's signal aborts.
 *
 * If the handler is inside a `next()` at that moment, the iterator is finished
 * right after that `next()` settles, never concurrently with it. Errors thrown
 * by the handler's `finally` are dropped: the client has already been told the
 * call was cancelled and there is no other recipient.
 *
 * When the interceptor finishes the iterator because the signal aborted after
 * the call began, the read that follows fails (see {@link cutStreamError}) instead
 * of reporting a normal end, so the client can tell a cut stream from a complete
 * one. A handler that ends by itself, with or without having seen the abort,
 * ends the call normally: that is its own decision. A call whose signal was
 * already aborted when it was opened is finished without that error.
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
                // Set when the interceptor itself ends the iterator because the call was
                // aborted mid-stream: the next read then reports why the stream stopped.
                let cut: ConnectError | undefined;

                // Cleanup is triggered from the abort listener, which runs in whatever async
                // context aborted the signal (a socket event, a timer, a shutdown). The handler's
                // `finally` must still see the AsyncLocalStorage values that were active when the
                // call's iterator was created, such as the verified caller identity and the
                // telemetry scope, so the cleanup is bound to the context captured here.
                const scope = new AsyncResource("finishStreamOnAbort");
                const closeIterator = scope.bind(async (): Promise<void> => {
                    await iterator.return?.();
                });

                // Settles when the handler's cleanup has run. The read that reports a cut waits for
                // it: the transport closes the request once that read fails, and graceful shutdown
                // proceeds to the shutdown hooks when the requests are closed, so reporting earlier
                // would let a hook close a resource that the handler's `finally` is still releasing.
                let closing: Promise<void> | undefined;

                const finish = async (reportCut: boolean): Promise<void> => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    if (reportCut) {
                        cut = cutStreamError(req.signal.reason);
                    }
                    req.signal.removeEventListener("abort", onAbort);
                    closing = closeIterator().catch(() => {
                        // see the interceptor documentation: nobody is left to receive this error
                    });
                    await closing;
                };

                const onAbort = (): void => {
                    if (!pulling) {
                        void finish(true);
                    }
                };

                if (req.signal.aborted) {
                    void finish(false);
                } else {
                    req.signal.addEventListener("abort", onAbort, { once: true });
                }

                return {
                    async next() {
                        if (cut) {
                            await closing;
                            throw cut;
                        }
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
                                void finish(true);
                            }
                        }
                    },
                    async return(value?: unknown) {
                        await finish(false);
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

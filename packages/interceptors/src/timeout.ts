/**
 * Timeout interceptor
 *
 * Prevents requests from hanging indefinitely.
 *
 * @module timeout
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { TimeoutStrategy, timeout } from "cockatiel";
import type { TimeoutOptions } from "./types.ts";
import { MAX_TIMER_MS, requireBoolean, requireInteger, requireOptionsObject } from "./validate.ts";

/**
 * Create timeout interceptor
 *
 * Prevents requests from hanging indefinitely by enforcing a timeout.
 * Propagates cancellation to downstream work and rejects with DeadlineExceeded
 * when its own deadline expires. Caller cancellation preserves its ConnectError
 * reason, or becomes Canceled when the caller supplies another reason.
 * Handlers and I/O must observe the signal to stop work; cancellation does not
 * roll back side effects or forcibly stop signal-unaware code.
 *
 * Streaming is skipped by default. With skipStreaming=false, the timeout covers
 * opening the response, not subsequent iteration. Caller cancellation continues
 * to reach an opened stream after the opening timer has been cleared, until the
 * reader is done with the stream (read to the end, failed, or closed early); then
 * the interceptor lets go of the caller's signal. A stream nobody iterates keeps
 * following the caller's signal until that signal aborts.
 *
 * `duration` must be an integer from 1 to 2147483647 milliseconds (the ceiling of
 * the platform timer, above which it would fire after 1 ms); anything else throws
 * at construction (`TypeError` for a non-number, `RangeError` otherwise).
 *
 * @param options - Timeout options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createTimeoutInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createTimeoutInterceptor({
 *       duration: 30000,      // 30 second timeout
 *       skipStreaming: true,  // Skip streaming calls
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 *
 * @example Client-side usage with transport
 * ```typescript
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createTimeoutInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   httpVersion: '1.1',
 *   interceptors: [
 *     createTimeoutInterceptor({ duration: 10000 }),
 *   ],
 * });
 * ```
 */
export function createTimeoutInterceptor(options: TimeoutOptions = {}): Interceptor {
    requireOptionsObject({ caller: "createTimeoutInterceptor", value: options });
    const { duration = 30000, skipStreaming = true } = options;

    // Validate options
    requireInteger({ caller: "createTimeoutInterceptor", option: "duration", value: duration, min: 1, max: MAX_TIMER_MS, unit: "milliseconds" });
    requireBoolean({ caller: "createTimeoutInterceptor", option: "skipStreaming", value: skipStreaming });

    // A successfully opened stream must keep running after the policy returns.
    const policy = timeout(duration, { strategy: TimeoutStrategy.Aggressive, abortOnReturn: false });

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        if (req.signal.aborted) {
            throw ConnectError.from(req.signal.reason, Code.Canceled);
        }

        const relay = new AbortController();
        let cancellation: ConnectError | undefined;
        let derivedSignal: AbortSignal | undefined;
        const cancelFromParent = () => {
            cancellation ??= ConnectError.from(req.signal.reason, Code.Canceled);
            // Downstream sees the caller's own reason, as it would from a signal derived
            // from the caller's; the mapped ConnectError is what this call throws.
            relay.abort(req.signal.reason);
        };
        const cancelFromPolicy = () => {
            cancellation ??= new ConnectError(`Request timeout after ${duration}ms`, Code.DeadlineExceeded);
            relay.abort(cancellation);
        };

        const stopFollowingCaller = () => req.signal.removeEventListener("abort", cancelFromParent);
        let keepFollowingCaller = false;

        // Register before the policy's parent link so caller abort wins its own
        // derived abort event. The first cause stays stable across later aborts.
        req.signal.addEventListener("abort", cancelFromParent, { once: true });
        try {
            const result = await policy.execute(({ signal }) => {
                derivedSignal = signal;
                signal.addEventListener("abort", cancelFromPolicy, { once: true });
                if (signal.aborted) {
                    cancelFromPolicy();
                }

                // The relay is all the downstream call needs: the caller's abort reaches
                // it through the listener above. Deriving the signal with `AbortSignal.any`
                // would hang a dependent signal on the caller's, and on a signal that
                // lives as long as the application (a shutdown signal shared by every
                // call) those links pile up, about 8 KB per call, and are never freed.
                // Other fields retain their descriptors and shared
                // headers/context/message identity.
                const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(req);
                descriptors.signal = { value: relay.signal, enumerable: true, configurable: true, writable: true };
                const downstreamRequest: typeof req = Object.create(Object.getPrototypeOf(req), descriptors);
                return next(downstreamRequest);
            }, req.signal);

            if (cancellation) {
                throw cancellation;
            }
            if (result.stream) {
                // An opened stream outlives this function and the policy has disposed
                // its own link on opening, so the caller's abort must keep reaching the
                // handler until the reader is done with the stream.
                keepFollowingCaller = true;
                return {
                    ...result,
                    message: releaseWhenDone(result.message, (failure) => {
                        if (failure !== undefined) {
                            // A transport tears its connection down when the signal it was
                            // given aborts, and the caller's own signal aborts only after the
                            // failure has travelled up to the code that owns it, by which time
                            // this link is gone. Abort downstream first, as that abort would.
                            relay.abort(ConnectError.from(failure.error));
                        }
                        stopFollowingCaller();
                    }),
                };
            }
            return result;
        } catch (err) {
            // TaskCancelledError can also originate in a handler; only an
            // observed abort of this call establishes a cancellation cause.
            throw cancellation ?? err;
        } finally {
            if (!keepFollowingCaller) {
                stopFollowingCaller();
            }
            derivedSignal?.removeEventListener("abort", cancelFromPolicy);
        }
    };
}

/**
 * Wrap a response stream so `release` runs once the reader is done with it: the
 * stream is read to the end, fails, or is closed early (`return()` / `break`).
 * `release` receives the error that ended the stream, or nothing when the stream
 * ended otherwise. A stream that nobody iterates is never released here, and the
 * caller's signal keeps its listener until it aborts; nothing reads such a stream.
 *
 * The iterator is wrapped by hand, not with an async generator: a generator that
 * is closed before its first step never runs its `finally`.
 */
function releaseWhenDone<T>(source: AsyncIterable<T>, release: (failure?: { error: unknown }) => void): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            const iterator = source[Symbol.asyncIterator]();
            return {
                async next(...args) {
                    try {
                        const step = await iterator.next(...args);
                        if (step.done) {
                            release();
                        }
                        return step;
                    } catch (error) {
                        release({ error });
                        throw error;
                    }
                },
                async return(value) {
                    try {
                        return iterator.return ? await iterator.return(value) : { done: true, value };
                    } finally {
                        release();
                    }
                },
            };
        },
    };
}

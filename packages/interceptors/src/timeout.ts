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
import { MAX_TIMER_MS, requireInteger } from "./validate.ts";

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
 * to reach an opened stream after the opening timer has been cleared.
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
    const { duration = 30000, skipStreaming = true } = options;

    // Validate options
    requireInteger({ caller: "createTimeoutInterceptor", option: "duration", value: duration, min: 1, max: MAX_TIMER_MS, unit: "milliseconds" });

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

                // A unary call is over when `next` settles, so the relay is all it needs:
                // the caller's abort reaches it through the listener above, which is
                // removed in `finally`. Deriving the signal with `AbortSignal.any` here
                // would hang a dependent signal on the caller's, and on a signal that
                // lives as long as the application (a shutdown signal shared by every
                // call) those links pile up, about 8 KB per call, and are never freed.
                //
                // An opened stream outlives this function, and the policy disposes its
                // own link on successful opening, so a stream keeps the original parent
                // linked through `AbortSignal.any`. Other fields retain their
                // descriptors and shared headers/context/message identity.
                const downstreamSignal = req.stream ? AbortSignal.any([req.signal, relay.signal]) : relay.signal;
                const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(req);
                descriptors.signal = { value: downstreamSignal, enumerable: true, configurable: true, writable: true };
                const downstreamRequest: typeof req = Object.create(Object.getPrototypeOf(req), descriptors);
                return next(downstreamRequest);
            }, req.signal);

            if (cancellation) {
                throw cancellation;
            }
            return result;
        } catch (err) {
            // TaskCancelledError can also originate in a handler; only an
            // observed abort of this call establishes a cancellation cause.
            throw cancellation ?? err;
        } finally {
            req.signal.removeEventListener("abort", cancelFromParent);
            derivedSignal?.removeEventListener("abort", cancelFromPolicy);
        }
    };
}

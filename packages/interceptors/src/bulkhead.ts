/**
 * Bulkhead interceptor
 *
 * Limits concurrent requests to prevent resource exhaustion.
 *
 * @module bulkhead
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { BulkheadOptions } from "./types.ts";
import { requireInteger } from "./validate.ts";

/** A call waiting for a slot; `grant` wakes it with the slot already counted as its own. */
interface Waiter {
    grant: () => void;
}

/**
 * Create bulkhead interceptor
 *
 * Limits concurrent requests to prevent resource exhaustion.
 * Requests beyond capacity are queued. Requests beyond queue size are rejected
 * with `ResourceExhausted` and the text `Bulkhead capacity exceeded (capacity: N,
 * queueSize: M)`; branch on the code, not on the text.
 *
 * Queued calls run in arrival order. A call whose request signal aborts while it
 * waits leaves the queue at once, frees its place and fails with `Canceled`
 * (the abort reason itself when it is a `ConnectError`); its handler never
 * runs. A call that arrives with an already aborted signal fails the same way
 * without taking a slot or a queue place. A slot is held until the downstream
 * call settles, so work that ignores its signal still counts against `capacity`.
 *
 * `capacity` must be an integer of at least 1 and `queueSize` an integer of at
 * least 0; anything else throws at construction (`TypeError` for a non-number,
 * `RangeError` otherwise).
 *
 * @param options - Bulkhead options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createBulkheadInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createBulkheadInterceptor({
 *       capacity: 10,       // Max 10 concurrent requests
 *       queueSize: 10,      // Queue up to 10 pending requests
 *       skipStreaming: true,
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
 * import { createBulkheadInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   httpVersion: '1.1',
 *   interceptors: [
 *     createBulkheadInterceptor({ capacity: 5, queueSize: 5 }),
 *   ],
 * });
 * ```
 */
export function createBulkheadInterceptor(options: BulkheadOptions = {}): Interceptor {
    const { capacity = 10, queueSize = 10, skipStreaming = true } = options;

    // Validate options
    requireInteger({ caller: "createBulkheadInterceptor", option: "capacity", value: capacity, min: 1 });
    requireInteger({ caller: "createBulkheadInterceptor", option: "queueSize", value: queueSize, min: 0 });

    // Slots in use. A slot is held until the downstream call settles, not until
    // the caller stops waiting for it: signal-unaware work still occupies capacity.
    let active = 0;
    const waiting: Waiter[] = [];

    // Hand a freed slot straight to the longest-waiting call (the slot count does
    // not change), or give it back when nobody waits.
    const release = (): void => {
        const waiter = waiting.shift();
        if (waiter) {
            waiter.grant();
        } else {
            active--;
        }
    };

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        const signal = req.signal;
        if (signal.aborted) {
            throw ConnectError.from(signal.reason, Code.Canceled);
        }

        if (active < capacity) {
            active++;
        } else if (waiting.length < queueSize) {
            // A cancelled waiter leaves the queue at once and frees its place:
            // the client has abandoned the call, so it must neither crowd out live
            // callers nor run its handler later with an aborted signal.
            await new Promise<void>((granted, cancelled) => {
                const waiter: Waiter = {
                    grant: () => {
                        signal.removeEventListener("abort", onAbort);
                        granted();
                    },
                };
                const onAbort = (): void => {
                    const index = waiting.indexOf(waiter);
                    if (index !== -1) {
                        waiting.splice(index, 1);
                    }
                    cancelled(ConnectError.from(signal.reason, Code.Canceled));
                };
                waiting.push(waiter);
                signal.addEventListener("abort", onAbort, { once: true });
            });

            // The slot was handed over together with the wake-up. The signal may have
            // aborted in between, before its listener could run: give the slot on.
            if (signal.aborted) {
                release();
                throw ConnectError.from(signal.reason, Code.Canceled);
            }
        } else {
            // The text states the configured limits only: a live occupancy figure
            // would race with concurrent releases anyway.
            throw new ConnectError(`Bulkhead capacity exceeded (capacity: ${capacity}, queueSize: ${queueSize})`, Code.ResourceExhausted);
        }

        try {
            return await next(req);
        } finally {
            release();
        }
    };
}

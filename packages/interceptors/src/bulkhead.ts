/**
 * Bulkhead interceptor
 *
 * Limits concurrent requests to prevent resource exhaustion.
 *
 * @module bulkhead
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { BulkheadRejectedError, bulkhead } from "cockatiel";
import type { BulkheadOptions } from "./types.ts";
import { requireInteger } from "./validate.ts";

/**
 * Create bulkhead interceptor
 *
 * Limits concurrent requests to prevent resource exhaustion.
 * Requests beyond capacity are queued. Requests beyond queue size are rejected
 * with `ResourceExhausted` and the text `Bulkhead capacity exceeded (capacity: N,
 * queueSize: M)`; branch on the code, not on the text.
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

    // Create bulkhead policy
    const policy = bulkhead(capacity, queueSize);

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        try {
            // Execute with bulkhead protection
            return await policy.execute(() => next(req));
        } catch (err) {
            // Convert BulkheadRejectedError to ConnectError. The text states the
            // configured limits only: the policy exposes FREE slots, and a live
            // occupancy figure would race with concurrent releases anyway.
            if (err instanceof BulkheadRejectedError) {
                throw new ConnectError(`Bulkhead capacity exceeded (capacity: ${capacity}, queueSize: ${queueSize})`, Code.ResourceExhausted);
            }

            // Re-throw other errors
            throw err;
        }
    };
}

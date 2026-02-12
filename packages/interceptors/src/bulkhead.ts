/**
 * Bulkhead interceptor
 *
 * Limits concurrent requests to prevent resource exhaustion.
 *
 * @module bulkhead
 */

import { Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import { BulkheadRejectedError, bulkhead } from "cockatiel";
import type { BulkheadOptions } from "./types.ts";

/**
 * Create bulkhead interceptor
 *
 * Limits concurrent requests to prevent resource exhaustion.
 * Requests beyond capacity are queued. Requests beyond queue size are rejected.
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
 *   interceptors: [
 *     createBulkheadInterceptor({ capacity: 5, queueSize: 5 }),
 *   ],
 * });
 * ```
 */
export function createBulkheadInterceptor(options: BulkheadOptions = {}): Interceptor {
    const { capacity = 10, queueSize = 10, skipStreaming = true } = options;

    // Validate options
    if (capacity < 1 || !Number.isFinite(capacity)) {
        throw new Error("capacity must be a positive finite number");
    }

    if (queueSize < 0 || !Number.isFinite(queueSize)) {
        throw new Error("queueSize must be a non-negative finite number");
    }

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
            // Convert BulkheadRejectedError to ConnectError
            if (err instanceof BulkheadRejectedError) {
                throw new ConnectError(
                    `Bulkhead capacity exceeded (active: ${policy.executionSlots}/${capacity}, queued: ${policy.queueSlots}/${queueSize})`,
                    Code.ResourceExhausted,
                );
            }

            // Re-throw other errors
            throw err;
        }
    };
}

/**
 * Middleware composition for event processing pipeline.
 *
 * Uses a dispatch pattern (similar to Koa) to build an onion model
 * where each middleware wraps the next, with double-call protection.
 *
 * @module middleware
 */

import type { EventContext, EventMiddleware, EventMiddlewareNext, RawEvent } from "./types.ts";

/**
 * Compose an array of middleware into a single handler.
 *
 * Middleware is applied from left to right (outer to inner).
 * The innermost function is the actual event handler.
 *
 * Uses a dispatch pattern that guards against double next() invocation.
 *
 * @param middlewares - Middleware functions to compose
 * @param handler - The final handler (innermost)
 * @returns Composed handler function
 */
export function composeMiddleware(
    middlewares: EventMiddleware[],
    handler: (event: RawEvent, ctx: EventContext) => Promise<void>,
): (event: RawEvent, ctx: EventContext) => Promise<void> {
    if (middlewares.length === 0) {
        return handler;
    }

    return async (initialEvent: RawEvent, ctx: EventContext) => {
        let index = -1;
        // Mutable event reference: middleware (e.g., retry) can replace
        // the event object without mutating readonly fields (C-1).
        let currentEvent = initialEvent;

        const dispatch = async (i: number): Promise<void> => {
            if (i <= index) {
                throw new Error("next() called multiple times");
            }
            index = i;

            if (i === middlewares.length) {
                return handler(currentEvent, ctx);
            }

            const middleware = middlewares[i];
            if (!middleware) {
                return;
            }

            try {
                const nextFn: EventMiddlewareNext = (updatedEvent) => {
                    if (updatedEvent) {
                        currentEvent = updatedEvent;
                    }
                    return dispatch(i + 1);
                };
                return await middleware(currentEvent, ctx, nextFn);
            } catch (error) {
                // Reset index to allow retry from this position (e.g., retry middleware)
                index = i - 1;
                throw error;
            }
        };

        return dispatch(0);
    };
}

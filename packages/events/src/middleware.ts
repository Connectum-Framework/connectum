/**
 * Middleware composition for event processing pipeline.
 *
 * Uses reduceRight to build an onion model where each middleware
 * wraps the next, similar to Express/Koa middleware.
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

    return middlewares.reduceRight<(event: RawEvent, ctx: EventContext) => Promise<void>>((next, middleware) => {
        return (event: RawEvent, ctx: EventContext) => {
            const nextFn: EventMiddlewareNext = () => next(event, ctx);
            return middleware(event, ctx, nextFn);
        };
    }, handler);
}

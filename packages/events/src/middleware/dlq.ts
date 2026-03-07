/**
 * Dead Letter Queue (DLQ) middleware for event processing.
 *
 * When a handler fails after all retries are exhausted,
 * publishes the event to a configured DLQ topic and
 * acknowledges the original event.
 *
 * @module middleware/dlq
 */

import type { DlqOptions, EventAdapter, EventMiddleware } from "../types.ts";

/**
 * Create a DLQ middleware that catches errors from inner middleware
 * (retry), publishes to DLQ topic, and acks the original.
 */
export function dlqMiddleware(options: DlqOptions, adapter: EventAdapter): EventMiddleware {
    return async (event, ctx, next) => {
        try {
            await next();
        } catch (error) {
            // Publish to DLQ with original event data + error metadata
            const metadata: Record<string, string> = {
                "dlq.original-topic": event.eventType,
                "dlq.original-id": event.eventId,
                "dlq.error": error instanceof Error ? error.message : String(error),
                "dlq.attempt": String(event.attempt),
            };

            await adapter.publish(options.topic, event.payload, { metadata });

            // Ack the original event so it's not redelivered
            await ctx.ack();
        }
    };
}

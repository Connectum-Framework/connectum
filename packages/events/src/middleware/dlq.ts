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
 * Default error serializer: returns only the error name (e.g. "TypeError")
 * to prevent leaking sensitive data such as credentials, tokens,
 * or connection strings that may appear in error messages.
 */
function defaultErrorSerializer(error: unknown): string {
    if (error instanceof Error) {
        return error.name;
    }
    return "UnknownError";
}

/**
 * Create a DLQ middleware that catches errors from inner middleware
 * (retry), publishes to DLQ topic, and acks the original.
 */
export function dlqMiddleware(options: DlqOptions, adapter: EventAdapter): EventMiddleware {
    const serializeError = options.errorSerializer ?? defaultErrorSerializer;

    return async (event, ctx, next) => {
        try {
            await next();
        } catch (error) {
            // Prevent DLQ self-loop: if the event is already on the DLQ topic, rethrow
            if (event.eventType === options.topic) {
                throw error;
            }

            // Publish to DLQ with original event data + error metadata
            const metadata: Record<string, string> = {
                "dlq.original-topic": event.eventType,
                "dlq.original-id": event.eventId,
                "dlq.error": serializeError(error),
                "dlq.attempt": String(event.attempt),
            };

            try {
                await adapter.publish(options.topic, event.payload, { metadata });
                await ctx.ack();
            } catch {
                // DLQ publish failed — nack without requeue to prevent infinite loop
                await ctx.nack(false);
            }
        }
    };
}

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

/** Default max length for error messages in DLQ metadata. */
const DEFAULT_MAX_ERROR_LENGTH = 200;

/**
 * Default error serializer: extracts error message and truncates.
 * Users can provide a custom `errorSerializer` in DlqOptions for
 * redaction of sensitive data (credentials, tokens, connection strings).
 */
function defaultErrorSerializer(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.slice(0, DEFAULT_MAX_ERROR_LENGTH);
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

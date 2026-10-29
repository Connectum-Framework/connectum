/**
 * Dead Letter Queue (DLQ) middleware for event processing.
 *
 * When a handler fails after all retries are exhausted,
 * publishes the event to a configured DLQ topic and
 * acknowledges the original event.
 *
 * @module middleware/dlq
 */

import { assertNonEmptyString } from "../optionValidation.ts";
import type { DlqOptions, EventAdapter, EventMiddleware } from "../types.ts";

/**
 * What a failed dead-letter publish reports: the dead-letter topic, the event that could not be
 * copied there (its original topic and id) and the error of the publish.
 */
export interface DlqPublishFailure {
    readonly topic: string;
    readonly eventType: string;
    readonly eventId: string;
    readonly error: unknown;
}

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
 *
 * If the publish to the DLQ fails, the original is nacked without requeue and the error is not
 * rethrown, so the event is no longer eligible for redelivery. `onPublishFailed` is the only
 * place that failure becomes visible; `createEventBus` forwards it to its `observer` as a
 * `dlq-failed` event. A throw from the callback is dropped, because reporting must not decide what
 * happens to the event.
 *
 * @throws {TypeError} When `options.topic` is not a string.
 * @throws {RangeError} When `options.topic` is empty or blank.
 */
export function dlqMiddleware(options: DlqOptions, adapter: Pick<EventAdapter, "publish">, onPublishFailed?: (failure: DlqPublishFailure) => void): EventMiddleware {
    assertNonEmptyString({ owner: "dlqMiddleware", name: "topic", value: options.topic });
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
            } catch (publishError) {
                try {
                    onPublishFailed?.({ topic: options.topic, eventType: event.eventType, eventId: event.eventId, error: publishError });
                } catch {
                    // dropped, see above
                }
                // DLQ publish failed — nack without requeue to prevent infinite loop
                await ctx.nack(false);
                return;
            }

            try {
                await ctx.ack();
            } catch {
                // The copy is on the DLQ topic; the ack failed, so settle the context the other way.
                // A context settles once: if the failed ack already did, this is a no-op and the
                // broker redelivers the original.
                await ctx.nack(false);
            }
        }
    };
}

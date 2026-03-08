/**
 * EventContext implementation.
 *
 * Wraps a RawEvent with idempotent ack/nack operations
 * and exposes structured metadata.
 *
 * @module EventContext
 */

import type { EventContext, EventContextInit } from "./types.ts";

/**
 * Create an EventContext from raw event data.
 *
 * The ack/nack operations are idempotent -- calling either
 * multiple times has no effect after the first call.
 */
export function createEventContext(init: EventContextInit): EventContext {
    let settled = false;

    return {
        signal: init.signal,
        eventId: init.raw.eventId,
        eventType: init.raw.eventType,
        publishedAt: init.raw.publishedAt,
        attempt: init.raw.attempt,
        metadata: init.raw.metadata,

        async ack(): Promise<void> {
            if (settled) return;
            settled = true;
            await init.onAck();
        },

        async nack(requeue = true): Promise<void> {
            if (settled) return;
            settled = true;
            await init.onNack(requeue);
        },
    };
}

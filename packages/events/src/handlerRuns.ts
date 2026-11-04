/**
 * How many times the handler was invoked for one delivery.
 *
 * The retry middleware runs inside the dead-letter middleware, so the latter cannot see the
 * attempts the former made. The retry middleware records the count against the delivery's
 * context, and the dead-letter middleware reads it when it publishes the `dlq.handler-runs`
 * header. The context object is the key because every middleware of one delivery receives the
 * same one, and a weak map drops the entry with the delivery.
 *
 * @module handlerRuns
 */

import type { EventContext } from "./types.ts";

const runs = new WeakMap<EventContext, number>();

/** Record that the handler is being invoked for the `count`-th time in this delivery. */
export function recordHandlerRun(ctx: EventContext, count: number): void {
    runs.set(ctx, count);
}

/** The recorded count, or 1 when no retry middleware ran: the handler is then invoked once. */
export function handlerRunsOf(ctx: EventContext): number {
    return runs.get(ctx) ?? 1;
}

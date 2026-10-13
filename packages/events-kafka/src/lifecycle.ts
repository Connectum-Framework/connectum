/**
 * Lifecycle reporting of the Kafka adapter.
 *
 * @module lifecycle
 */

import type { KafkaLifecycleCallbacks, KafkaLifecycleEvent } from "./types.ts";

/**
 * Deliver an event to `onLifecycle`, isolating the callback.
 *
 * The client runs its listeners inside the code that restarts a crashed consumer: an exception
 * thrown from a `CRASH` listener aborts the scheduling of the restart, and the subscription dies
 * without a trace. The failure is reported once as a `lifecycle-error` event; a failure while
 * handling that event is dropped, so the report path cannot recurse. A returned promise is attached
 * to but never awaited.
 */
export function dispatchLifecycle(lifecycle: KafkaLifecycleCallbacks | undefined, event: KafkaLifecycleEvent): void {
    const onLifecycle = lifecycle?.onLifecycle;
    if (onLifecycle === undefined) {
        return;
    }
    const report = (error: unknown): void => {
        if (event.type === "lifecycle-error") {
            return;
        }
        dispatchLifecycle(lifecycle, {
            type: "lifecycle-error",
            callback: "onLifecycle",
            event: event.type,
            error: error instanceof Error ? error : new Error(String(error), { cause: error }),
        });
    };
    try {
        const result: unknown = onLifecycle.call(lifecycle, event);
        // A callable `then` rather than `instanceof Promise`: a promise from another realm or a userland thenable must be isolated too.
        if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
            (result as PromiseLike<unknown>).then(undefined, report);
        }
    } catch (error) {
        report(error);
    }
}

/** Payload of the client's crash event. */
export interface ConsumerCrashPayload {
    readonly error: Error;
    readonly groupId: string;
    readonly restart: boolean;
}

/**
 * Track one subscription's consumer: the first crash is `consumer-lost`, a crash before it came back is
 * `consumer-restore-failed` with a counted attempt, and the first group join after a crash is
 * `consumer-restored`. A group join without a preceding crash (the first join, rebalances, the restart
 * topic discovery causes) produces nothing.
 */
export function trackConsumer(lifecycle: KafkaLifecycleCallbacks): { onCrash: (payload: ConsumerCrashPayload) => void; onGroupJoin: (payload: { groupId: string }) => void } {
    let lost = false;
    let failedRestarts = 0;
    return {
        onCrash({ error, groupId, restart }) {
            if (!lost) {
                lost = true;
                failedRestarts = 0;
                dispatchLifecycle(lifecycle, { type: "consumer-lost", groupId, error, willRestore: restart });
                return;
            }
            failedRestarts += 1;
            dispatchLifecycle(lifecycle, { type: "consumer-restore-failed", groupId, attempt: failedRestarts, error, willRetry: restart });
        },
        onGroupJoin({ groupId }) {
            if (!lost) {
                return;
            }
            lost = false;
            dispatchLifecycle(lifecycle, { type: "consumer-restored", groupId, attempt: failedRestarts + 1 });
            failedRestarts = 0;
        },
    };
}

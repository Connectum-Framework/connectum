/**
 * Connection lifecycle reporting of the NATS adapter.
 *
 * @module lifecycle
 */

import type { NatsConnection } from "@nats-io/transport-node";
import type { NatsLifecycleCallbacks, NatsLifecycleEvent } from "./types.ts";

/**
 * Deliver an event to `onLifecycle`, isolating the callback.
 *
 * A callback that throws, or returns a rejected promise, must not stop the status loop (the loop
 * would end silently and no further event would be reported) nor surface as an unhandled rejection.
 * The failure is reported once as a `lifecycle-error` event; a failure while handling that event is
 * dropped, so the report path cannot recurse. A returned promise is attached to but never awaited:
 * a slow callback must not delay the loop or `disconnect()`.
 */
export function dispatchLifecycle(lifecycle: NatsLifecycleCallbacks | undefined, event: NatsLifecycleEvent): void {
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

/**
 * Report the connection's status events through `onLifecycle` until the connection closes.
 *
 * Mapping from the client's status events: `disconnect` to `disconnected`, `reconnecting` to
 * `reconnecting` with an attempt counted here (reset on `reconnect`), `reconnect` to
 * `connected { reconnected: true }`. Everything else (`staleConnection` and `forceReconnect`
 * precede a `disconnect` and would count one loss twice; `error`, `ldm`, `update`, `ping`,
 * `slowConsumer` are not losses of the connection) produces nothing. When the client closes
 * without `isClosing()` being true, `onUnexpectedClose` runs first and then one terminal `reconnect-failed` carries
 * the error the client closed with.
 *
 * Returns once the status iterator ends, which the client does when the connection closes.
 */
export async function watchConnection(connection: NatsConnection, lifecycle: NatsLifecycleCallbacks, isClosing: () => boolean, onUnexpectedClose: () => void): Promise<void> {
    let attempt = 0;
    try {
        for await (const status of connection.status()) {
            switch (status.type) {
                case "disconnect":
                    attempt = 0;
                    dispatchLifecycle(lifecycle, { type: "disconnected", server: status.server });
                    break;
                case "reconnecting":
                    attempt += 1;
                    dispatchLifecycle(lifecycle, { type: "reconnecting", attempt });
                    break;
                case "reconnect":
                    attempt = 0;
                    dispatchLifecycle(lifecycle, { type: "connected", reconnected: true, server: status.server });
                    break;
                default:
                    break;
            }
        }
    } catch {
        // The status iterator ends with the connection; an error from it carries nothing the close below does not.
    }
    const closedWith = await connection.closed().catch((error: unknown) => error);
    if (!isClosing()) {
        // The adapter must stop presenting this dead connection as its own before anyone is told it is gone.
        onUnexpectedClose();
        const error = closedWith instanceof Error ? closedWith : new Error("NATS connection closed without a disconnect() call");
        dispatchLifecycle(lifecycle, { type: "reconnect-failed", error });
    }
}

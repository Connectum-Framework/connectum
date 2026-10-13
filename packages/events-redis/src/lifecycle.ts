/**
 * Connection lifecycle reporting of the Redis adapter.
 *
 * @module lifecycle
 */

import type { RedisLifecycleCallbacks, RedisLifecycleConnection, RedisLifecycleEvent } from "./types.ts";

/**
 * Deliver an event to `onLifecycle`, isolating the callback.
 *
 * The client emits its status events from a process tick, so a callback that throws would become an
 * uncaught exception. The failure is reported once as a `lifecycle-error` event; a failure while
 * handling that event is dropped, so the report path cannot recurse. A returned promise is attached
 * to but never awaited.
 */
export function dispatchLifecycle(lifecycle: RedisLifecycleCallbacks | undefined, event: RedisLifecycleEvent): void {
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

/** The part of a client the watcher listens to. */
export interface WatchableRedisClient {
    on(event: "ready" | "close" | "end", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    on(event: "reconnecting", listener: (delay: number) => void): unknown;
}

/**
 * Report one client connection's events through `onLifecycle`.
 *
 * Mapping: the first `ready` is `connected { reconnected: false }`, a later `ready` is
 * `connected { reconnected: true }` and resets the attempt count; `close` after a `ready` is one
 * `disconnected` (the client emits `close` for every failed attempt too, those are silent because no
 * `ready` came in between); `reconnecting(delay)` is `reconnecting` with an attempt counted here;
 * `end` is the terminal `reconnect-failed`. Nothing is reported for a client the adapter closes
 * itself (`isOwnClose`), and `error` is only remembered as the cause of the next event.
 */
export function watchConnection(client: WatchableRedisClient, connection: RedisLifecycleConnection, lifecycle: RedisLifecycleCallbacks, isOwnClose: () => boolean): void {
    let everReady = false;
    let ready = false;
    let attempt = 0;
    let lastError: Error | undefined;
    const cause = (fallback: string): Error => lastError ?? new Error(fallback);

    client.on("error", (error: Error) => {
        lastError = error;
    });
    client.on("ready", () => {
        ready = true;
        attempt = 0;
        const reconnected = everReady;
        everReady = true;
        lastError = undefined;
        dispatchLifecycle(lifecycle, { type: "connected", reconnected, connection });
    });
    client.on("close", () => {
        if (!ready || isOwnClose()) {
            return;
        }
        ready = false;
        dispatchLifecycle(lifecycle, { type: "disconnected", error: cause("Redis connection closed"), connection });
    });
    client.on("reconnecting", (delay: number) => {
        // Before the first ready the caller of connect() gets the error itself; a redial of the initial attempt is not a lost connection.
        if (!everReady || isOwnClose()) {
            return;
        }
        attempt += 1;
        dispatchLifecycle(lifecycle, { type: "reconnecting", attempt, delay, error: cause("Redis connection lost"), connection });
    });
    client.on("end", () => {
        if (!everReady || isOwnClose()) {
            return;
        }
        dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: cause("Redis client ended without a close by the adapter"), connection });
    });
}

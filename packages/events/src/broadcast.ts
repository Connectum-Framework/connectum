/**
 * Broadcast / fan-out helper.
 *
 * To deliver ONE published event to N INDEPENDENT reactors (each reacting on its
 * own), each reactor must live on its OWN EventBus with its OWN consumer group:
 *
 *  - the per-bus duplicate-topic guard rejects two routes resolving to the same
 *    topic on one bus, and
 *  - on a real broker, a SHARED group load-balances (one reactor "steals" each
 *    event) while DISTINCT groups give each reactor its own durable consumer.
 *
 * {@link createBroadcastSubscribers} builds that one-bus-per-reactor wiring from
 * a list of reactors, so callers do not hand-roll N `createEventBus` calls.
 *
 * @module broadcast
 */

import type { EventBusLike } from "@connectum/core";
import { createEventBus } from "./EventBus.ts";
import type { EventAdapter, EventBus, EventRoute, MiddlewareConfig } from "./types.ts";

/** One independent broadcast reactor: its consumer group + routes. */
export interface BroadcastReactor {
    /** Consumer group — MUST be DISTINCT per reactor for true fan-out (a shared group load-balances). */
    readonly group: string;
    /** The event routes (handlers) this reactor subscribes with. */
    readonly routes: EventRoute[];
    /** Optional per-reactor middleware (retry/DLQ/custom). */
    readonly middleware?: MiddlewareConfig;
}

/** Options for {@link createBroadcastSubscribers}. */
export interface BroadcastSubscribersOptions {
    /**
     * The broker adapter. Pass ONE shared instance (fine for `MemoryAdapter` in
     * tests, where all buses share the in-memory registry) OR a factory invoked
     * once per reactor (use this for real brokers so each reactor bus gets its
     * own connection / durable consumer).
     */
    readonly adapter: EventAdapter | (() => EventAdapter);
    /** The independent reactors — each becomes its own EventBus with its own group. */
    readonly reactors: BroadcastReactor[];
    /** Shared per-bus handler timeout (ms). */
    readonly handlerTimeout?: number;
    /** Shared per-bus drain timeout (ms). */
    readonly drainTimeout?: number;
    /** Shared abort signal for graceful shutdown. */
    readonly signal?: AbortSignal;
}

/**
 * Build one `EventBus` per reactor (each with its own consumer group) so a
 * single published event fans out to ALL reactors independently.
 *
 * The returned buses are NOT started — start them yourself (e.g.
 * `await Promise.all(buses.map((b) => b.start()))`) and stop them on shutdown.
 *
 * Throws if two reactors share a consumer group (that would load-balance / steal
 * instead of fanning out).
 *
 * @example
 * ```typescript
 * const buses = createBroadcastSubscribers({
 *   adapter: () => new NatsAdapter({ servers, stream: 'orders' }),
 *   reactors: [
 *     { group: 'pricing', routes: [pricingRoutes] },
 *     { group: 'audit',   routes: [auditRoutes] },
 *     { group: 'notify',  routes: [notifyRoutes] },
 *   ],
 * });
 * await Promise.all(buses.map((bus) => bus.start()));
 * ```
 */
export function createBroadcastSubscribers(options: BroadcastSubscribersOptions): Array<EventBus & EventBusLike> {
    const seen = new Set<string>();
    for (const reactor of options.reactors) {
        if (seen.has(reactor.group)) {
            throw new Error(
                `createBroadcastSubscribers: duplicate consumer group "${reactor.group}". Each broadcast reactor needs a DISTINCT group for true fan-out — a shared group load-balances (one reactor steals each event) instead of broadcasting.`,
            );
        }
        seen.add(reactor.group);
    }

    return options.reactors.map((reactor) =>
        createEventBus({
            adapter: typeof options.adapter === "function" ? options.adapter() : options.adapter,
            routes: reactor.routes,
            group: reactor.group,
            // Spread optionals only when set — the package uses
            // `exactOptionalPropertyTypes`, so an explicit `undefined` is rejected.
            ...(reactor.middleware !== undefined ? { middleware: reactor.middleware } : {}),
            ...(options.handlerTimeout !== undefined ? { handlerTimeout: options.handlerTimeout } : {}),
            ...(options.drainTimeout !== undefined ? { drainTimeout: options.drainTimeout } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }),
    );
}

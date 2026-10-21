/**
 * In-memory event adapter for testing.
 *
 * Supports wildcard patterns (* and >) and synchronous
 * delivery. No external broker required.
 *
 * @module MemoryAdapter
 */

import { randomUUID } from "node:crypto";
import { assertPublishTopic, assertSubscriptionPatterns } from "./subscriptionPatterns.ts";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "./types.ts";
import { matchPattern } from "./wildcard.ts";

interface MemorySubscription {
    readonly patterns: string[];
    readonly handler: RawEventHandler;
    /** Redeliveries of this subscription that have been scheduled but have not run yet. */
    readonly pendingRedeliveries: Set<NodeJS.Timeout>;
}

/**
 * Create an in-memory adapter for testing event flows
 * without an external message broker.
 */
export function MemoryAdapter(): EventAdapter {
    const subscriptions: MemorySubscription[] = [];
    let connected = false;

    function cancelRedeliveries(sub: MemorySubscription): void {
        for (const timer of sub.pendingRedeliveries) {
            clearTimeout(timer);
        }
        sub.pendingRedeliveries.clear();
    }

    /**
     * Hand one event to one subscription. `ack` is a no-op (nothing is persisted). `nack(true)` (the
     * default) puts the event back to the SAME subscription, as a broker returns it to the queue of
     * the consumer group: the redelivery runs as a later macrotask with `attempt` raised, never
     * synchronously, so a handler that always nacks yields to timers and I/O between attempts
     * instead of starving them. `nack(false)` discards the event, like a rejection without a
     * dead-letter exchange. A redelivery still waiting when the subscription is removed (or the
     * adapter disconnected) is dropped: that is what keeps a bus that is stopping from looping
     * nack, redeliver, nack while it drains.
     */
    async function deliver(sub: MemorySubscription, event: RawEvent): Promise<void> {
        const noopAck = async (): Promise<void> => {};
        const nack = async (requeue?: boolean): Promise<void> => {
            if (requeue === false || !subscriptions.includes(sub)) {
                return;
            }
            const timer = setTimeout(() => {
                sub.pendingRedeliveries.delete(timer);
                if (!subscriptions.includes(sub)) {
                    return;
                }
                // A redelivery has no caller to throw to, so a failing handler only ends that attempt.
                void deliver(sub, { ...event, attempt: event.attempt + 1 }).catch(() => undefined);
            }, 0);
            timer.unref();
            sub.pendingRedeliveries.add(timer);
        };
        await sub.handler(event, noopAck, nack);
    }

    return {
        name: "memory",

        async connect(_context?: AdapterContext): Promise<void> {
            connected = true;
        },

        async disconnect(): Promise<void> {
            for (const sub of subscriptions) {
                cancelRedeliveries(sub);
            }
            subscriptions.length = 0;
            connected = false;
        },

        async publish(eventType: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
            if (!connected) {
                throw new Error("MemoryAdapter: not connected");
            }

            // Same rule as subscribe(): a topic no subscription pattern can name is not delivered
            // to wildcard subscribers either.
            assertPublishTopic({ adapter: "MemoryAdapter", topic: eventType });

            const event: RawEvent = {
                eventId: randomUUID(),
                eventType,
                payload,
                publishedAt: new Date(),
                attempt: 1,
                metadata: new Map(Object.entries(options?.metadata ?? {})),
            };

            // Deliver to matching subscribers
            const matchingSubs = subscriptions.filter((sub) => sub.patterns.some((pattern) => matchPattern(pattern, eventType)));

            // Deliver sequentially (memory adapter is synchronous)
            for (const sub of matchingSubs) {
                await deliver(sub, event);
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, _options?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!connected) {
                throw new Error("MemoryAdapter: not connected");
            }

            assertSubscriptionPatterns({ adapter: "MemoryAdapter", patterns });

            const sub: MemorySubscription = { patterns, handler, pendingRedeliveries: new Set() };
            subscriptions.push(sub);

            return {
                async unsubscribe(): Promise<void> {
                    const idx = subscriptions.indexOf(sub);
                    if (idx !== -1) {
                        subscriptions.splice(idx, 1);
                    }
                    cancelRedeliveries(sub);
                },
            };
        },
    };
}

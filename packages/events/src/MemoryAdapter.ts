/**
 * In-memory event adapter for testing.
 *
 * Supports wildcard patterns (* and >) and synchronous
 * delivery. No external broker required.
 *
 * @module MemoryAdapter
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "./types.ts";
import { matchPattern } from "./wildcard.ts";

interface MemorySubscription {
    readonly patterns: string[];
    readonly handler: RawEventHandler;
}

/**
 * Create an in-memory adapter for testing event flows
 * without an external message broker.
 */
export function MemoryAdapter(): EventAdapter {
    const subscriptions: MemorySubscription[] = [];
    let connected = false;

    return {
        name: "memory",

        async connect(_context?: AdapterContext): Promise<void> {
            connected = true;
        },

        async disconnect(): Promise<void> {
            subscriptions.length = 0;
            connected = false;
        },

        async publish(eventType: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
            if (!connected) {
                throw new Error("MemoryAdapter: not connected");
            }

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

            // No-op ack/nack for in-memory adapter (no persistence layer)
            const noopAck = async (): Promise<void> => {};
            const noopNack = async (_requeue?: boolean): Promise<void> => {};

            // Deliver sequentially (memory adapter is synchronous)
            for (const sub of matchingSubs) {
                await sub.handler(event, noopAck, noopNack);
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, _options?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!connected) {
                throw new Error("MemoryAdapter: not connected");
            }

            const sub: MemorySubscription = { patterns, handler };
            subscriptions.push(sub);

            return {
                async unsubscribe(): Promise<void> {
                    const idx = subscriptions.indexOf(sub);
                    if (idx !== -1) {
                        subscriptions.splice(idx, 1);
                    }
                },
            };
        },
    };
}

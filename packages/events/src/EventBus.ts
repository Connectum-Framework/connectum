/**
 * EventBus implementation.
 *
 * Central component managing adapter, routes, middleware pipeline,
 * and event publishing. Implements EventBusLike for server integration.
 *
 * @module EventBus
 */

import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { EventBusLike } from "@connectum/core";
import { createEventContext } from "./EventContext.ts";
import { EventRouterImpl } from "./EventRouter.ts";
import { dlqMiddleware } from "./middleware/dlq.ts";
import { retryMiddleware } from "./middleware/retry.ts";
import { composeMiddleware } from "./middleware.ts";
import type { EventBus, EventBusOptions, EventContext, EventMiddleware, EventSubscription, PublishOptions, RawEvent } from "./types.ts";

/**
 * Create an EventBus instance.
 *
 * @param options - EventBus configuration
 * @returns EventBus instance implementing EventBusLike for server integration
 *
 * @example
 * ```typescript
 * import { createEventBus, MemoryAdapter } from '@connectum/events';
 *
 * const eventBus = createEventBus({
 *   adapter: MemoryAdapter(),
 *   routes: [myEventRoutes],
 *   middleware: {
 *     retry: { maxRetries: 3, backoff: 'exponential' },
 *     dlq: { topic: 'my-service.dlq' },
 *   },
 * });
 *
 * await eventBus.start();
 * await eventBus.publish(UserCreatedSchema, { id: '1', email: 'a@b.c', name: 'Test' });
 * await eventBus.stop();
 * ```
 */
export function createEventBus(options: EventBusOptions): EventBus & EventBusLike {
    const { adapter, routes = [], group, middleware: mwConfig } = options;
    const subscriptions: EventSubscription[] = [];
    let started = false;
    let shutdownSignal: AbortSignal | undefined = options.signal;

    // Build routes
    const router = new EventRouterImpl();
    for (const route of routes) {
        route(router);
    }

    // Build middleware chain
    const middlewares: EventMiddleware[] = [];

    // User custom middleware (outermost)
    if (mwConfig?.custom) {
        middlewares.push(...mwConfig.custom);
    }

    // Retry middleware
    if (mwConfig?.retry) {
        middlewares.push(retryMiddleware(mwConfig.retry));
    }

    // DLQ middleware (innermost, after retry)
    if (mwConfig?.dlq) {
        middlewares.push(dlqMiddleware(mwConfig.dlq, adapter));
    }

    return {
        async start(startOptions?: { signal?: AbortSignal }): Promise<void> {
            if (started) {
                throw new Error("EventBus already started");
            }

            // Accept shutdown signal from server integration (C-2)
            if (startOptions?.signal) {
                shutdownSignal = startOptions.signal;
            }

            await adapter.connect();
            started = true;

            // Build topic → handler map and compose middleware per topic
            const topicHandlerMap = new Map<string, (event: RawEvent, ctx: EventContext) => Promise<void>>();

            for (const entry of router.entries) {
                const composedHandler = composeMiddleware(middlewares, async (rawEvent, ctx) => {
                    const message = fromBinary(entry.method.input, rawEvent.payload);
                    await entry.handler(message, ctx);
                });
                topicHandlerMap.set(entry.topic, composedHandler);
            }

            // Single subscribe call with all topics — prevents Kafka consumer group conflicts
            if (topicHandlerMap.size > 0) {
                const allTopics = [...topicHandlerMap.keys()];

                const sub = await adapter.subscribe(
                    allTopics,
                    async (rawEvent: RawEvent, ack: () => Promise<void>, nack: (requeue?: boolean) => Promise<void>) => {
                        const handler = topicHandlerMap.get(rawEvent.eventType);
                        if (!handler) {
                            await ack();
                            return;
                        }

                        // Compose per-event signal: timeout + optional server shutdown (C-2)
                        const eventSignal = shutdownSignal ? AbortSignal.any([shutdownSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);

                        // Track settlement to auto-ack if handler doesn't call ack/nack (C-1)
                        let settled = false;
                        const ctx = createEventContext({
                            raw: rawEvent,
                            signal: eventSignal,
                            onAck: async () => {
                                settled = true;
                                await ack();
                            },
                            onNack: async (requeue) => {
                                settled = true;
                                await nack(requeue);
                            },
                        });

                        try {
                            await handler(rawEvent, ctx);
                        } finally {
                            // Auto-ack fallback for backward compatibility (C-1)
                            if (!settled) {
                                await ack();
                            }
                        }
                    },
                    group !== undefined ? { group } : {},
                );

                subscriptions.push(sub);
            }
        },

        async stop(): Promise<void> {
            if (!started) return;

            // Unsubscribe all
            for (const sub of subscriptions) {
                await sub.unsubscribe();
            }
            subscriptions.length = 0;

            await adapter.disconnect();
            started = false;
        },

        async publish<Desc extends DescMessage>(schema: Desc, data: MessageShape<Desc>, publishOptions?: PublishOptions): Promise<void> {
            if (!started) {
                throw new Error("EventBus not started. Call start() first.");
            }

            // Create message instance and serialize
            const message = create(schema, data);
            const payload = toBinary(schema, message);
            const eventType = publishOptions?.topic ?? schema.typeName;

            await adapter.publish(eventType, payload, publishOptions);
        },
    };
}

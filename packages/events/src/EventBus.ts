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
// biome-ignore lint/correctness/useImportExtensions: workspace package, not a relative import
import type { EventBusLike } from "@connectum/core";
import { createEventContext } from "./EventContext.ts";
import { EventRouterImpl } from "./EventRouter.ts";
import { dlqMiddleware } from "./middleware/dlq.ts";
import { retryMiddleware } from "./middleware/retry.ts";
import { composeMiddleware } from "./middleware.ts";
import type { EventBus, EventBusOptions, EventContext, EventMiddleware, EventSubscription, PublishOptions, RawEvent } from "./types.ts";
import { matchPattern } from "./wildcard.ts";

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
    const handlerTimeout = options.handlerTimeout ?? 30_000;
    const subscriptions: EventSubscription[] = [];
    let started = false;
    let starting = false;
    let stopping = false;
    let startPromise: Promise<void> | null = null;
    let stopPromise: Promise<void> | null = null;
    const drainTimeout = options.drainTimeout ?? 30_000;
    const inFlight = new Set<Promise<void>>();
    let drainController = new AbortController();
    let draining = false;
    const defaultSignal = options.signal;
    let shutdownSignal: AbortSignal | undefined;

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

    // DLQ middleware (outermost of built-in — catches after retry exhaustion)
    if (mwConfig?.dlq) {
        middlewares.push(dlqMiddleware(mwConfig.dlq, adapter));
    }

    // Retry middleware (innermost of built-in — retries before DLQ sees error)
    if (mwConfig?.retry) {
        middlewares.push(retryMiddleware(mwConfig.retry));
    }

    return {
        async start(startOptions?: { signal?: AbortSignal }): Promise<void> {
            if (started || starting || stopping) {
                throw new Error("EventBus already started or stopping");
            }

            starting = true;

            // Accept shutdown signal from server integration (C-2)
            shutdownSignal = startOptions?.signal ?? defaultSignal;

            startPromise = (async () => {
                try {
                    await adapter.connect();

                    // Build topic → handler map and compose middleware per topic
                    const topicHandlerMap = new Map<string, (event: RawEvent, ctx: EventContext) => Promise<void>>();

                    for (const entry of router.entries) {
                        if (topicHandlerMap.has(entry.topic)) {
                            throw new Error(`Duplicate event topic "${entry.topic}". Use (connectum.events.v1.event).topic option to disambiguate.`);
                        }
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
                                // Exact match first, then wildcard fallback
                                let handler = topicHandlerMap.get(rawEvent.eventType);
                                if (!handler) {
                                    for (const [pattern, h] of topicHandlerMap) {
                                        if (pattern !== rawEvent.eventType && matchPattern(pattern, rawEvent.eventType)) {
                                            handler = h;
                                            break;
                                        }
                                    }
                                }
                                if (!handler) {
                                    await ack();
                                    return;
                                }

                                // Gate: nack new messages during drain
                                if (draining) {
                                    await nack(true);
                                    return;
                                }

                                // Compose per-event signal: timeout + optional server shutdown + drain (C-2, M-5)
                                const signals: AbortSignal[] = [AbortSignal.timeout(handlerTimeout), drainController.signal];
                                if (shutdownSignal) signals.push(shutdownSignal);
                                const eventSignal = AbortSignal.any(signals);

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

                                const handlerPromise = (async () => {
                                    let completed = false;
                                    try {
                                        await handler(rawEvent, ctx);
                                        completed = true;
                                    } finally {
                                        // Auto-ack fallback for backward compatibility (C-1)
                                        if (!settled && completed) {
                                            try {
                                                await ack();
                                            } catch {
                                                // Auto-ack failed — message will be redelivered by broker timeout
                                            }
                                        }
                                    }
                                })();
                                inFlight.add(handlerPromise);
                                try {
                                    await handlerPromise;
                                } finally {
                                    inFlight.delete(handlerPromise);
                                }
                            },
                            group !== undefined ? { group } : {},
                        );

                        subscriptions.push(sub);
                    }

                    started = true;
                } catch (error) {
                    await Promise.allSettled(subscriptions.map((sub) => sub.unsubscribe()));
                    subscriptions.length = 0;
                    await adapter.disconnect();
                    throw error;
                } finally {
                    starting = false;
                    startPromise = null;
                }
            })();

            return startPromise;
        },

        async stop(): Promise<void> {
            if (stopPromise) return stopPromise;

            // If start() is in progress, wait for it to complete, then stop
            if (starting && startPromise) {
                await startPromise.catch(() => {});
                // After start completes (or fails), re-check state
                if (!started) return;
            }

            if (!started) return;

            stopping = true;
            draining = true;

            stopPromise = (async () => {
                try {
                    // 1. Close iterators — stop receiving new messages
                    await Promise.allSettled(subscriptions.map((sub) => sub.unsubscribe()));
                    subscriptions.length = 0;

                    // 2. Drain in-flight handlers with timeout
                    if (inFlight.size > 0 && drainTimeout > 0) {
                        const deadline = Date.now() + drainTimeout;

                        while (inFlight.size > 0) {
                            const remaining = deadline - Date.now();
                            if (remaining <= 0) break;

                            await Promise.race([
                                Promise.allSettled([...inFlight]),
                                new Promise<void>((resolve) => {
                                    globalThis.setTimeout(resolve, remaining);
                                }),
                            ]);
                        }
                    }

                    // 3. Force-abort remaining handlers if still in-flight
                    if (inFlight.size > 0) {
                        drainController.abort("Drain timeout exceeded");
                        // Brief settle window for abort handlers
                        await Promise.allSettled([...inFlight]);
                    }

                    inFlight.clear();
                    await adapter.disconnect();
                } finally {
                    started = false;
                    shutdownSignal = undefined;
                    stopping = false;
                    draining = false;
                    drainController = new AbortController();
                    stopPromise = null;
                }
            })();

            return stopPromise;
        },

        async publish<Desc extends DescMessage>(schema: Desc, data: MessageShape<Desc>, publishOptions?: PublishOptions): Promise<void> {
            if (!started || stopping) {
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

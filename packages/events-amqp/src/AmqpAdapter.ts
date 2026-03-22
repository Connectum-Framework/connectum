/**
 * AMQP/RabbitMQ adapter for `@connectum/events`.
 *
 * Implements the {@link EventAdapter} interface on top of AMQP 0-9-1 (RabbitMQ),
 * providing at-least-once delivery with topic exchanges, consumer groups via
 * named queues, and dead-letter exchange support.
 *
 * @module AmqpAdapter
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import type amqp from "amqplib";
import type { AmqpAdapterOptions } from "./types.ts";

/** Default exchange name when none is provided. */
const DEFAULT_EXCHANGE = "connectum.events";

/** Default exchange type. */
const DEFAULT_EXCHANGE_TYPE = "topic";

/** Default prefetch count. */
const DEFAULT_PREFETCH = 10;

/**
 * Convert an EventBus wildcard pattern to an AMQP routing key pattern.
 *
 * EventBus uses NATS-style wildcards:
 * - `*` matches a single token (same in AMQP topic exchange)
 * - `>` matches one or more tokens (AMQP uses `#`)
 *
 * @param pattern - EventBus wildcard pattern
 * @returns AMQP routing key pattern
 */
export function toAmqpPattern(pattern: string): string {
    return pattern.replace(/>/g, "#");
}

/**
 * Parse AMQP message headers into a `Map<string, string>`.
 *
 * Only string-coercible values are included. All headers are passed
 * through; internal EventBus headers (`x-event-id`, `x-published-at`)
 * are removed by the consumer callback after extraction.
 */
function parseHeaders(headers: Record<string, unknown> | undefined): Map<string, string> {
    const map = new Map<string, string>();
    if (!headers) {
        return map;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && value !== null) {
            map.set(key, String(value));
        }
    }
    return map;
}

/**
 * Create an AMQP/RabbitMQ adapter for @connectum/events.
 *
 * @param options - AMQP adapter configuration
 * @returns EventAdapter instance
 *
 * @example
 * ```typescript
 * import { AmqpAdapter } from "@connectum/events-amqp";
 * import { createEventBus } from "@connectum/events";
 *
 * const bus = createEventBus({
 *     adapter: AmqpAdapter({ url: "amqp://guest:guest@localhost:5672" }),
 *     routes: [myRoutes],
 * });
 * await bus.start();
 * ```
 */
export function AmqpAdapter(options: AmqpAdapterOptions): EventAdapter {
    const exchange = options.exchange ?? DEFAULT_EXCHANGE;
    const exchangeType = options.exchangeType ?? DEFAULT_EXCHANGE_TYPE;

    let connection: amqp.ChannelModel | null = null;
    let publishChannel: amqp.ConfirmChannel | null = null;

    /** Active subscription handles for cleanup on disconnect. */
    const activeSubs: EventSubscription[] = [];

    return {
        name: "amqp",

        async connect(context?: AdapterContext): Promise<void> {
            if (connection) {
                throw new Error("AmqpAdapter: already connected");
            }

            // Dynamic import to avoid top-level require issues with ESM
            const amqplib = await import("amqplib");

            const clientProperties: Record<string, string> = {};
            if (context?.serviceName) {
                clientProperties.connection_name = context.serviceName;
            }

            const conn = await amqplib.connect(
                options.url,
                options.socketOptions
                    ? {
                          ...options.socketOptions,
                          clientProperties: Object.keys(clientProperties).length > 0 ? clientProperties : undefined,
                      }
                    : Object.keys(clientProperties).length > 0
                      ? { clientProperties }
                      : undefined,
            );

            // Handle connection-level errors to prevent unhandled rejections
            conn.on("error", (err: Error) => {
                console.error("[AmqpAdapter] connection error:", err.message);
            });

            try {
                // Create a ConfirmChannel for publisher confirms (sync mode)
                const ch = await conn.createConfirmChannel();

                // Assert exchange
                await ch.assertExchange(exchange, exchangeType, {
                    durable: options.exchangeOptions?.durable ?? true,
                    autoDelete: options.exchangeOptions?.autoDelete ?? false,
                });

                // Commit to closure state
                connection = conn;
                publishChannel = ch;
            } catch (err) {
                await conn.close().catch(() => undefined);
                throw err;
            }
        },

        async disconnect(): Promise<void> {
            // Unsubscribe all active subscriptions first (with error isolation).
            const unsubResults = await Promise.allSettled([...activeSubs].map((sub) => sub.unsubscribe()));
            for (const r of unsubResults) {
                if (r.status === "rejected") {
                    console.error("[AmqpAdapter] unsubscribe error:", r.reason);
                }
            }
            activeSubs.length = 0;

            if (publishChannel) {
                await publishChannel.close().catch(() => undefined);
                publishChannel = null;
            }

            if (connection) {
                await connection.close().catch(() => undefined);
                connection = null;
            }
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            const ch = publishChannel;
            if (!ch) {
                throw new Error("AmqpAdapter: not connected");
            }

            const routingKey = eventType;
            const eventId = randomUUID();

            // Build headers: user metadata first, then internal
            const headers: Record<string, string> = {};

            if (publishOptions?.metadata) {
                for (const [key, value] of Object.entries(publishOptions.metadata)) {
                    // Skip only internal EventBus headers to prevent spoofing
                    if (key === "x-event-id" || key === "x-published-at") {
                        continue;
                    }
                    headers[key] = String(value);
                }
            }

            headers["x-event-id"] = eventId;
            headers["x-published-at"] = new Date().toISOString();

            const persistent = options.publisherOptions?.persistent ?? true;
            const mandatory = options.publisherOptions?.mandatory ?? false;

            const written = ch.publish(exchange, routingKey, Buffer.from(payload), {
                persistent,
                mandatory,
                headers,
                contentType: "application/protobuf",
                messageId: eventId,
                timestamp: Math.trunc(Date.now() / 1000),
            });

            // Handle back-pressure: wait for channel drain if buffer is full
            if (!written) {
                await new Promise<void>((resolve) => ch.once("drain", resolve));
            }

            if (publishOptions?.sync) {
                // Wait for broker confirmation
                await ch.waitForConfirms();
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!connection) {
                throw new Error("AmqpAdapter: not connected");
            }

            const isAutoGroup = !subOptions?.group;
            const group = subOptions?.group;

            // Create a dedicated channel for this subscription
            const ch = await connection.createChannel();

            const prefetch = options.consumerOptions?.prefetch ?? DEFAULT_PREFETCH;
            await ch.prefetch(prefetch);

            // Build queue options
            const queueArgs: Record<string, unknown> = {};
            if (options.queueOptions?.messageTtl !== undefined) {
                queueArgs["x-message-ttl"] = options.queueOptions.messageTtl;
            }
            if (options.queueOptions?.maxLength !== undefined) {
                queueArgs["x-max-length"] = options.queueOptions.maxLength;
            }
            if (options.queueOptions?.deadLetterExchange !== undefined) {
                queueArgs["x-dead-letter-exchange"] = options.queueOptions.deadLetterExchange;
            }
            if (options.queueOptions?.deadLetterRoutingKey !== undefined) {
                queueArgs["x-dead-letter-routing-key"] = options.queueOptions.deadLetterRoutingKey;
            }

            // Named queue for group (shared, competing consumers) or
            // auto-delete queue for non-group (exclusive fan-out)
            const queueName = group ? `${exchange}.${group}` : `${exchange}.sub-${randomUUID()}`;

            const queueDurable = options.queueOptions?.durable ?? true;
            const exclusive = options.consumerOptions?.exclusive ?? false;

            await ch.assertQueue(queueName, {
                durable: group ? queueDurable : false,
                autoDelete: isAutoGroup,
                exclusive: isAutoGroup ? exclusive : false,
                arguments: Object.keys(queueArgs).length > 0 ? queueArgs : undefined,
            });

            // Bind queue to exchange for each pattern
            const amqpPatterns = patterns.map(toAmqpPattern);
            for (const amqpPattern of amqpPatterns) {
                await ch.bindQueue(queueName, exchange, amqpPattern);
            }

            /** Track consumer tags for cancellation. */
            const consumerTags: string[] = [];

            // Start consuming
            const consumeResult = await ch.consume(
                queueName,
                (msg: amqp.ConsumeMessage | null) => {
                    if (!msg) {
                        // Consumer cancelled by broker
                        return;
                    }

                    const msgHeaders = parseHeaders(msg.properties.headers as Record<string, unknown> | undefined);

                    const eventId = msgHeaders.get("x-event-id") ?? msg.properties.messageId ?? randomUUID();

                    const publishedAtStr = msgHeaders.get("x-published-at");
                    const publishedAt = publishedAtStr ? new Date(publishedAtStr) : msg.properties.timestamp ? new Date(msg.properties.timestamp * 1000) : new Date();

                    // Remove internal headers from metadata
                    msgHeaders.delete("x-event-id");
                    msgHeaders.delete("x-published-at");

                    // Attempt: redelivered = at least 2nd delivery
                    const attempt = msg.fields.redelivered ? 2 : 1;

                    const rawEvent: RawEvent = {
                        eventId,
                        eventType: msg.fields.routingKey,
                        payload: new Uint8Array(msg.content),
                        publishedAt: Number.isFinite(publishedAt.getTime()) ? publishedAt : new Date(),
                        attempt,
                        metadata: msgHeaders,
                    };

                    const ack = async (): Promise<void> => {
                        ch.ack(msg);
                    };
                    const nack = async (requeue?: boolean): Promise<void> => {
                        if (requeue === false) {
                            // Reject without requeue — goes to DLX or is discarded
                            ch.nack(msg, false, false);
                        } else {
                            // Reject with requeue
                            ch.nack(msg, false, true);
                        }
                    };

                    handler(rawEvent, ack, nack).catch(() => {
                        // Handler error — nack for redelivery
                        ch.nack(msg, false, true);
                    });
                },
                { noAck: false },
            );

            consumerTags.push(consumeResult.consumerTag);

            const subscription: EventSubscription = {
                async unsubscribe(): Promise<void> {
                    // Cancel consumers
                    for (const tag of consumerTags) {
                        await ch.cancel(tag).catch(() => undefined);
                    }
                    consumerTags.length = 0;

                    // Delete auto-generated queues to prevent broker-side leak
                    if (isAutoGroup) {
                        await ch.deleteQueue(queueName).catch(() => undefined);
                    }

                    // Unbind patterns (cleanup for named groups)
                    if (!isAutoGroup) {
                        for (const amqpPattern of amqpPatterns) {
                            await ch.unbindQueue(queueName, exchange, amqpPattern).catch(() => undefined);
                        }
                    }

                    await ch.close().catch(() => undefined);

                    // Remove from the active subscriptions list
                    const idx = activeSubs.indexOf(subscription);
                    if (idx !== -1) {
                        activeSubs.splice(idx, 1);
                    }
                },
            };

            activeSubs.push(subscription);
            return subscription;
        },
    };
}

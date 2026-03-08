/**
 * Kafka/Redpanda adapter for @connectum/events.
 *
 * Implements the EventAdapter interface using KafkaJS.
 * Supports topic patterns via Kafka's regex subscription.
 *
 * @module KafkaAdapter
 */

import { randomUUID } from "node:crypto";
import type { EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import type { Consumer, EachBatchPayload, IHeaders, Producer } from "kafkajs";
import { Kafka } from "kafkajs";
import type { KafkaAdapterOptions } from "./types.ts";

/**
 * Parse a timestamp from header string or Kafka numeric timestamp.
 * Returns current time if both are missing or invalid.
 */
function parseTimestamp(headerValue: string | undefined, kafkaTimestamp: string | undefined): Date {
    if (headerValue) {
        const d = new Date(headerValue);
        if (Number.isFinite(d.getTime())) return d;
    }
    if (kafkaTimestamp) {
        const n = Number(kafkaTimestamp);
        if (Number.isFinite(n)) return new Date(n);
    }
    return new Date();
}

/**
 * Convert NATS-style wildcard patterns to Kafka-compatible RegExp.
 *
 * - `*` matches a single segment (between dots)
 * - `>` matches one or more segments (greedy)
 * - Literal patterns are returned as-is (string)
 *
 * @param pattern - NATS-style topic pattern
 * @returns RegExp for Kafka topic subscription, or the original string if no wildcards
 */
function patternToKafkaTopicMatcher(pattern: string): string | RegExp {
    if (!pattern.includes("*") && !pattern.includes(">")) {
        return pattern;
    }

    // Escape regex special characters except our wildcards
    const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^.]+")
        .replace(/>/g, ".+");

    return new RegExp(`^${escaped}$`);
}

/**
 * Parse Kafka message headers into a Map<string, string>.
 *
 * KafkaJS headers can contain Buffer, string, or arrays thereof.
 * This normalizes all values to strings.
 */
function parseHeaders(headers: IHeaders | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!headers) {
        return result;
    }

    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            // Take the first element for simplicity
            const [first] = value;
            if (first !== undefined) {
                result.set(key, Buffer.isBuffer(first) ? first.toString("utf-8") : String(first));
            }
        } else {
            result.set(key, Buffer.isBuffer(value) ? value.toString("utf-8") : String(value));
        }
    }

    return result;
}

/**
 * Encode metadata entries as Kafka message headers.
 */
function encodeMetadata(metadata: Record<string, string>): IHeaders {
    const headers: IHeaders = {};
    for (const [key, value] of Object.entries(metadata)) {
        headers[key] = Buffer.from(value, "utf-8");
    }
    return headers;
}

/**
 * Create a Kafka/Redpanda adapter for @connectum/events.
 *
 * @param options - Kafka adapter configuration
 * @returns EventAdapter instance
 *
 * @example
 * ```typescript
 * import { KafkaAdapter } from "@connectum/events-kafka";
 *
 * const adapter = KafkaAdapter({
 *     brokers: ["localhost:9092"],
 *     clientId: "my-service",
 * });
 *
 * await adapter.connect();
 * await adapter.publish("user.created", payload);
 * await adapter.disconnect();
 * ```
 */
export function KafkaAdapter(options: KafkaAdapterOptions): EventAdapter {
    const kafka = new Kafka({
        clientId: options.clientId ?? "connectum",
        brokers: options.brokers,
        ...options.kafkaConfig,
    });

    let producer: Producer | null = null;
    const consumers: Consumer[] = [];
    let connected = false;

    return {
        name: "kafka",

        async connect(): Promise<void> {
            if (connected) {
                return;
            }
            const p = kafka.producer();
            try {
                await p.connect();
            } catch (err) {
                await p.disconnect().catch(() => undefined);
                throw err;
            }
            producer = p;
            connected = true;
        },

        async disconnect(): Promise<void> {
            if (!connected) {
                return;
            }

            // Disconnect all consumers (continue on individual failures)
            const results = await Promise.allSettled(consumers.map((c) => c.disconnect()));
            for (const r of results) {
                if (r.status === "rejected") {
                    console.error("[KafkaAdapter] consumer disconnect error:", r.reason);
                }
            }
            consumers.length = 0;

            // Then disconnect the producer
            if (producer) {
                await producer.disconnect();
                producer = null;
            }

            connected = false;
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            if (!connected || !producer) {
                throw new Error("KafkaAdapter: not connected");
            }

            const headers: IHeaders = {};

            // User metadata first
            if (publishOptions?.metadata) {
                const userHeaders = encodeMetadata(publishOptions.metadata);
                Object.assign(headers, userHeaders);
            }

            // Internal headers last (overwrite any user spoofing)
            headers["x-event-id"] = Buffer.from(randomUUID(), "utf-8");
            headers["x-published-at"] = Buffer.from(new Date().toISOString(), "utf-8");

            const compression = options.producerOptions?.compression;

            await producer.send({
                topic: eventType,
                messages: [
                    {
                        key: publishOptions?.key ?? null,
                        value: Buffer.from(payload),
                        headers,
                    },
                ],
                ...(compression !== undefined && { compression }),
            });
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!connected) {
                throw new Error("KafkaAdapter: not connected");
            }

            const groupId = subOptions?.group ?? `connectum-${randomUUID()}`;
            const sessionTimeout = options.consumerOptions?.sessionTimeout;
            const consumer = kafka.consumer({
                groupId,
                allowAutoTopicCreation: options.consumerOptions?.allowAutoTopicCreation ?? false,
                ...(sessionTimeout !== undefined && { sessionTimeout }),
            });

            await consumer.connect();

            try {
                // Convert patterns to Kafka topic subscriptions
                const topics: (string | RegExp)[] = patterns.map(patternToKafkaTopicMatcher);
                const fromBeginning = options.consumerOptions?.fromBeginning ?? false;

                await consumer.subscribe({ topics, fromBeginning });

                await consumer.run({
                    autoCommit: false,
                    eachBatch: async ({ batch, resolveOffset, commitOffsetsIfNecessary, heartbeat }: EachBatchPayload) => {
                        for (const message of batch.messages) {
                            const msgHeaders = parseHeaders(message.headers);

                            // Extract event ID from headers or use message key/offset
                            const eventId = msgHeaders.get("x-event-id") ?? message.key?.toString("utf-8") ?? randomUUID();

                            const publishedAt = parseTimestamp(msgHeaders.get("x-published-at"), message.timestamp);

                            // Kafka does not natively track delivery attempts across redeliveries.
                            // Attempt defaults to 1; retry middleware tracks retries internally.
                            const attempt = 1;

                            // Remove internal headers from metadata
                            msgHeaders.delete("x-event-id");
                            msgHeaders.delete("x-published-at");

                            const rawEvent: RawEvent = {
                                eventId,
                                eventType: batch.topic,
                                payload: message.value ? new Uint8Array(message.value) : new Uint8Array(),
                                publishedAt,
                                attempt,
                                metadata: msgHeaders,
                            };

                            // Real ack/nack wired through to EventBus (C-1)
                            let nacked = false;
                            const ack = async (): Promise<void> => {
                                resolveOffset(message.offset);
                                await commitOffsetsIfNecessary();
                            };
                            const nack = async (requeue?: boolean): Promise<void> => {
                                if (requeue === false) {
                                    // "Reject without requeue" — commit offset so the message
                                    // won't be redelivered. DLQ middleware already saved a copy.
                                    resolveOffset(message.offset);
                                    await commitOffsetsIfNecessary();
                                } else {
                                    nacked = true;
                                }
                            };

                            try {
                                await handler(rawEvent, ack, nack);
                            } catch {
                                // Handler error — stop batch, KafkaJS will retry from this offset
                                break;
                            }

                            if (nacked) break; // Stop processing, retry from this offset
                            await heartbeat();
                        }
                    },
                });
            } catch (err) {
                await consumer.disconnect().catch(() => undefined);
                throw err;
            }

            consumers.push(consumer);

            return {
                async unsubscribe(): Promise<void> {
                    const idx = consumers.indexOf(consumer);
                    if (idx !== -1) {
                        consumers.splice(idx, 1);
                    }
                    await consumer.disconnect();
                },
            };
        },
    };
}

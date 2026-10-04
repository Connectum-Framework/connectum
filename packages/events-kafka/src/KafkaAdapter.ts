/**
 * Kafka/Redpanda adapter for @connectum/events.
 *
 * Implements the EventAdapter interface using KafkaJS.
 * Supports topic patterns via Kafka's regex subscription.
 *
 * @module KafkaAdapter
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import type { Consumer, IHeaders, Producer } from "kafkajs";
import { Kafka } from "kafkajs";
import { createBatchConsumer } from "./consumeBatch.ts";
import type { KafkaAdapterOptions } from "./types.ts";

/**
 * Pause between redeliveries of an unsettled message when `consumerOptions.redeliveryDelay` is not set.
 * Without a pause a permanently failing handler is retried at network speed, thousands of times a second.
 */
const defaultRedeliveryDelayMs = 1_000;

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
    if (pattern.length > 256) {
        throw new Error(`Topic pattern exceeds maximum length (256): ${pattern.length}`);
    }

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
    // Node.js replaces a timer delay above this value with 1 ms, which would turn a long pause into a hot redelivery loop.
    const maxTimerDelayMs = 2_147_483_647;
    const redeliveryDelay = options.consumerOptions?.redeliveryDelay ?? defaultRedeliveryDelayMs;
    if (!Number.isFinite(redeliveryDelay) || redeliveryDelay < 0 || redeliveryDelay > maxTimerDelayMs) {
        throw new RangeError(
            `KafkaAdapter: consumerOptions.redeliveryDelay must be a non-negative finite number of milliseconds (at most ${maxTimerDelayMs}), got ${redeliveryDelay}`,
        );
    }

    let kafka: Kafka;

    let producer: Producer | null = null;
    const consumers: Consumer[] = [];
    let connected = false;

    return {
        name: "kafka",

        async connect(context?: AdapterContext): Promise<void> {
            if (connected) {
                return;
            }
            kafka = new Kafka({
                clientId: options.clientId ?? context?.serviceName ?? "connectum",
                brokers: options.brokers,
                ...options.kafkaConfig,
            });
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

            /** Pending partition resumes of this subscription, cleared on unsubscribe. */
            const resumeTimers = new Set<NodeJS.Timeout>();

            try {
                // Convert patterns to Kafka topic subscriptions
                const topics: (string | RegExp)[] = patterns.map(patternToKafkaTopicMatcher);
                const fromBeginning = options.consumerOptions?.fromBeginning ?? false;

                await consumer.subscribe({ topics, fromBeginning });

                // `autoCommit: false` and `eachBatchAutoResolve: false` hand every offset
                // decision to ack/nack(false); see createBatchConsumer.
                await consumer.run({
                    autoCommit: false,
                    eachBatchAutoResolve: false,
                    eachBatch: createBatchConsumer({ handler, redeliveryDelay, resumeTimers }),
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
                    for (const timer of resumeTimers) {
                        clearTimeout(timer);
                    }
                    resumeTimers.clear();
                    await consumer.disconnect();
                },
            };
        },
    };
}

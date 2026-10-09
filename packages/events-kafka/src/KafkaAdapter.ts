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
import type { Admin, Consumer, IHeaders, Producer } from "kafkajs";
import { Kafka } from "kafkajs";
import { createBatchConsumer, defaultHeartbeatIntervalMs } from "./consumeBatch.ts";
import { startTopicDiscovery } from "./topicDiscovery.ts";
import type { KafkaAdapterOptions } from "./types.ts";

/**
 * Pause between redeliveries of an unsettled message when `consumerOptions.redeliveryDelay` is not set.
 * Without a pause a permanently failing handler is retried at network speed, thousands of times a second.
 */
const defaultRedeliveryDelayMs = 1_000;

/**
 * How often a wildcard subscription checks the broker for new matching topics when
 * `consumerOptions.topicDiscoveryInterval` is not set. The same period the Java client and
 * KafkaJS use to refresh cluster metadata (`metadata.max.age.ms`, `metadataMaxAge`): one
 * metadata request per wildcard subscription every five minutes, whose size grows with the
 * number of topics on the cluster.
 */
export const defaultTopicDiscoveryIntervalMs = 300_000;

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

    // Kafka names its own topics with a leading double underscore (`__consumer_offsets`,
    // `__transaction_state`). A pattern that opens with a wildcard would subscribe them and feed
    // the broker's binary bookkeeping records to the event handler, so it must not match them.
    // A pattern that spells the prefix out (`__audit.>`) asks for such topics and keeps them.
    const opensWithWildcard = pattern.startsWith("*") || pattern.startsWith(">");
    const guard = opensWithWildcard ? "(?!__)" : "";

    return new RegExp(`^${guard}${escaped}$`);
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

    const commitStrategy = options.consumerOptions?.commitStrategy ?? "per-message";
    if (commitStrategy !== "per-message" && commitStrategy !== "per-batch") {
        throw new RangeError(`KafkaAdapter: consumerOptions.commitStrategy must be "per-message" or "per-batch", got ${JSON.stringify(commitStrategy)}`);
    }

    // Discovery is on unless `false` is set: without it a wildcard subscription never sees a topic
    // created after it started, and the group skips what was published there before the next restart.
    const topicDiscoveryOption = options.consumerOptions?.topicDiscoveryInterval ?? defaultTopicDiscoveryIntervalMs;
    const topicDiscoveryInterval = topicDiscoveryOption === false ? undefined : topicDiscoveryOption;
    if (topicDiscoveryInterval !== undefined && (!Number.isFinite(topicDiscoveryInterval) || topicDiscoveryInterval <= 0 || topicDiscoveryInterval > maxTimerDelayMs)) {
        throw new RangeError(
            `KafkaAdapter: consumerOptions.topicDiscoveryInterval must be a positive finite number of milliseconds (at most ${maxTimerDelayMs}), got ${topicDiscoveryInterval}`,
        );
    }

    let kafka: Kafka;

    let producer: Producer | null = null;
    const consumers: Consumer[] = [];
    let connected = false;

    /** Admin client used to list topics for wildcard discovery; opened on first use. */
    let admin: Admin | null = null;
    let adminConnecting: Promise<Admin> | null = null;
    /** Stops the topic discovery of every live subscription. */
    const discoveryStops = new Set<() => Promise<void>>();

    const openAdmin = async (): Promise<Admin> => {
        const candidate = kafka.admin();
        try {
            await candidate.connect();
        } catch (err) {
            await candidate.disconnect().catch(() => undefined);
            throw err;
        }
        admin = candidate;
        return candidate;
    };

    const getAdmin = async (): Promise<Admin> => {
        if (admin !== null) {
            return admin;
        }
        // Concurrent callers share one connection attempt; a failed attempt is not remembered.
        adminConnecting ??= openAdmin().finally(() => {
            adminConnecting = null;
        });
        return adminConnecting;
    };

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

            // Topic discovery restarts consumers; it must be over before they are disconnected.
            await Promise.allSettled([...discoveryStops].map((stop) => stop()));
            discoveryStops.clear();

            // Disconnect all consumers (continue on individual failures)
            const results = await Promise.allSettled(consumers.map((c) => c.disconnect()));
            for (const r of results) {
                if (r.status === "rejected") {
                    console.error("[KafkaAdapter] consumer disconnect error:", r.reason);
                }
            }
            consumers.length = 0;

            if (admin !== null) {
                await admin.disconnect().catch((err: unknown) => {
                    console.error("[KafkaAdapter] admin disconnect error:", err);
                });
                admin = null;
            }

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
                heartbeatInterval: defaultHeartbeatIntervalMs,
                ...(sessionTimeout !== undefined && { sessionTimeout }),
            });

            await consumer.connect();

            /** Pending partition resumes of this subscription, cleared on unsubscribe. */
            const resumeTimers = new Set<NodeJS.Timeout>();

            // `autoCommit: false` and `eachBatchAutoResolve: false` hand every offset
            // decision to ack/nack(false); see createBatchConsumer.
            const runConfig = {
                autoCommit: false,
                eachBatchAutoResolve: false,
                eachBatch: createBatchConsumer({ handler, commitStrategy, heartbeatInterval: defaultHeartbeatIntervalMs, redeliveryDelay, resumeTimers }),
            } as const;

            /** Stops this subscription's topic discovery, if it has any. */
            let stopDiscovery: (() => Promise<void>) | undefined;

            try {
                // Convert patterns to Kafka topic subscriptions
                const topics: (string | RegExp)[] = patterns.map(patternToKafkaTopicMatcher);
                const wildcards = topics.filter((topic): topic is RegExp => topic instanceof RegExp);
                const fromBeginning = options.consumerOptions?.fromBeginning ?? false;

                // The topics that exist when the subscription starts are the ones KafkaJS expands the
                // wildcards to; anything listed later that matches is new. Listing first means a topic
                // created in between is seen again at the first check, which costs one needless restart
                // and loses nothing.
                const known = new Set<string>();
                if (topicDiscoveryInterval !== undefined && wildcards.length > 0) {
                    for (const name of await (await getAdmin()).listTopics()) {
                        known.add(name);
                    }
                }

                await consumer.subscribe({ topics, fromBeginning });
                await consumer.run(runConfig);

                if (topicDiscoveryInterval !== undefined && wildcards.length > 0) {
                    stopDiscovery = startTopicDiscovery({
                        consumer,
                        wildcards,
                        known,
                        runConfig,
                        resumeTimers,
                        interval: topicDiscoveryInterval,
                        listTopics: async () => (await getAdmin()).listTopics(),
                    });
                    discoveryStops.add(stopDiscovery);
                }
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
                    if (stopDiscovery !== undefined) {
                        discoveryStops.delete(stopDiscovery);
                        await stopDiscovery();
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

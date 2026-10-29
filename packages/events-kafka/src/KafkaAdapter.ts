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
import { assertPublishTopic, assertSubscriptionPatterns } from "@connectum/events";
import type { Admin, IHeaders, Producer } from "kafkajs";
import { Kafka } from "kafkajs";
import { explainConnectionError, explainInvalidTopic } from "./brokerErrors.ts";
import { assertKafkaOptions, buildClientConfig, compressionOf } from "./clientConfig.ts";
import { createBatchConsumer, defaultHeartbeatIntervalMs } from "./consumeBatch.ts";
import { dispatchLifecycle, trackConsumer } from "./lifecycle.ts";
import { subscribeToTopics } from "./subscribeTopics.ts";
import { startTopicDiscovery } from "./topicDiscovery.ts";
import { createTopicRecovery } from "./topicRecovery.ts";
import type { KafkaAdapterOptions } from "./types.ts";

/**
 * Pause between redeliveries of an unsettled message when `consumerOptions.redeliveryDelay` is not set.
 * Without a pause a permanently failing handler is retried at network speed, thousands of times a second.
 */
const defaultRedeliveryDelayMs = 1_000;

/** What the adapter keeps of a live subscription to close it on `disconnect()`; its consumer may be replaced after a topic deletion. */
interface ConsumerHandle {
    readonly disconnect: () => Promise<void>;
}

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
    assertKafkaOptions(options);

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
    const consumers = new Set<ConsumerHandle>();
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
            explainConnectionError(err);
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

    /** The connect() attempt under way, shared by every overlapping call. */
    let connecting: Promise<void> | null = null;

    const openProducer = async (context: AdapterContext | undefined): Promise<void> => {
        kafka = new Kafka(buildClientConfig(options, options.clientId ?? context?.serviceName ?? "connectum"));
        const p = kafka.producer();
        try {
            await p.connect();
        } catch (err) {
            await p.disconnect().catch(() => undefined);
            explainConnectionError(err);
            throw err;
        }
        producer = p;
        connected = true;
        dispatchLifecycle(options.lifecycle, { type: "connected", reconnected: false });
    };

    return {
        name: "kafka",

        connect(context?: AdapterContext): Promise<void> {
            if (connected) {
                return Promise.resolve();
            }
            // Overlapping calls share one attempt: each would otherwise create its own producer, and the
            // one assigned last would replace the others, which nothing could ever disconnect again.
            // A failed attempt is not remembered, so the next call starts a new one.
            connecting ??= openProducer(context).finally(() => {
                connecting = null;
            });
            return connecting;
        },

        async disconnect(): Promise<void> {
            // A disconnect that arrives while connect() is under way ends the connection that attempt makes.
            await connecting?.catch(() => undefined);
            if (!connected) {
                return;
            }

            // Topic discovery restarts consumers; it must be over before they are disconnected.
            await Promise.allSettled([...discoveryStops].map((stop) => stop()));
            discoveryStops.clear();

            // Disconnect all consumers (continue on individual failures)
            const results = await Promise.allSettled([...consumers].map((c) => c.disconnect()));
            for (const r of results) {
                if (r.status === "rejected") {
                    console.error("[KafkaAdapter] consumer disconnect error:", r.reason);
                }
            }
            consumers.clear();

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
            // The broker's answer to a reserved name does not name the topic.
            assertPublishTopic({ adapter: "KafkaAdapter", topic: eventType, rule: "kafka-topic-name" });

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

            const compression = compressionOf(options);

            try {
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
            } catch (err) {
                explainConnectionError(err);
                throw explainInvalidTopic(eventType, err);
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            // Before a consumer is created and connected: Kafka refuses these topic names and the
            // broker's answer ("invalid topic") does not name the pattern.
            assertSubscriptionPatterns({ adapter: "KafkaAdapter", patterns, rule: "kafka-topic-name" });

            if (!connected) {
                throw new Error("KafkaAdapter: not connected");
            }

            // A pattern that is too long is an argument error: refuse it here, before a consumer is
            // created and connected, so the refusal costs the broker nothing.
            const topics: (string | RegExp)[] = patterns.map(patternToKafkaTopicMatcher);

            const groupId = subOptions?.group ?? `connectum-${randomUUID()}`;
            const sessionTimeout = options.consumerOptions?.sessionTimeout;
            const allowAutoTopicCreation = options.consumerOptions?.allowAutoTopicCreation ?? false;
            const wildcards = topics.filter((topic): topic is RegExp => topic instanceof RegExp);
            const literals = topics.filter((topic): topic is string => typeof topic === "string");
            const fromBeginning = options.consumerOptions?.fromBeginning ?? false;
            // One tracker for the subscription, not one per consumer: a consumer replaced after a crash must continue the same loss and recovery.
            const tracker = options.lifecycle?.onLifecycle !== undefined ? trackConsumer(options.lifecycle) : undefined;

            /** Pending partition resumes of this subscription, cleared on unsubscribe. */
            const resumeTimers = new Set<NodeJS.Timeout>();

            // `autoCommit: false` and `eachBatchAutoResolve: false` hand every offset
            // decision to ack/nack(false); see createBatchConsumer.
            const runConfig = {
                autoCommit: false,
                eachBatchAutoResolve: false,
                eachBatch: createBatchConsumer({ handler, commitStrategy, heartbeatInterval: defaultHeartbeatIntervalMs, redeliveryDelay, resumeTimers }),
            } as const;

            // The topics on the broker when the subscription starts: the ones KafkaJS expands the
            // wildcards to; anything listed later that matches is new. Listing first means a topic
            // created in between is seen again at the first check, which costs one needless restart
            // and loses nothing. A failed listing fails the subscription: continuing with an empty
            // list would make every existing topic look new at the first check, and the restart
            // would read their whole history from the beginning although `fromBeginning` is off.
            // KafkaJS expands the wildcards with the same metadata request, so a broker that
            // cannot answer this one fails the subscribe below anyway. The list is also what tells a
            // topic that was deleted from one that never existed, so it is taken whether or not topic
            // discovery runs.
            const known = new Set<string>();
            /** The same list, frozen at the start: tells a topic the consumer began with from one found later. */
            const started = new Set<string>();

            const recovery = createTopicRecovery({
                createConsumer: ({ onCrash, restartOnFailure }) => {
                    const consumer = kafka.consumer({
                        groupId,
                        allowAutoTopicCreation,
                        heartbeatInterval: defaultHeartbeatIntervalMs,
                        ...(sessionTimeout !== undefined && { sessionTimeout }),
                        // Only a wildcard subscription can be replaced. 5 is the client's own default for a consumer's retries, which giving `retry` would otherwise replace.
                        ...(wildcards.length > 0 && { retry: { retries: 5, restartOnFailure } }),
                    });
                    // Attached before the consumer runs, so a crash of the first run is not missed. Without a lifecycle callback and without wildcards no listener exists.
                    if (tracker !== undefined || wildcards.length > 0) {
                        consumer.on(consumer.events.CRASH, (event) => {
                            // A crash the recovery takes over is reported as one the subscription will recover from.
                            const reported = onCrash(event.payload);
                            tracker?.onCrash(reported);
                        });
                    }
                    if (tracker !== undefined) {
                        consumer.on(consumer.events.GROUP_JOIN, (event) => tracker.onGroupJoin(event.payload));
                    }
                    return consumer;
                },
                literals,
                wildcards,
                known,
                started,
                fromBeginning,
                discover: topicDiscoveryInterval !== undefined,
                runConfig,
                resumeTimers,
                listTopics: async () => (await getAdmin()).listTopics(),
                subscribe: (consumer, names, beginning) => subscribeToTopics({ consumer, topics: names, fromBeginning: beginning, allowAutoTopicCreation }),
            });

            const consumer = recovery.spawn();
            try {
                await consumer.connect();
            } catch (err) {
                explainConnectionError(err);
                throw err;
            }

            /** Stops this subscription's topic discovery, if it has any. */
            let stopDiscovery: (() => Promise<void>) | undefined;

            try {
                if (wildcards.length > 0) {
                    for (const name of await (await getAdmin()).listTopics()) {
                        known.add(name);
                        started.add(name);
                    }
                }

                await subscribeToTopics({ consumer, topics, fromBeginning, allowAutoTopicCreation });
                if (wildcards.length > 0 && topicDiscoveryInterval === undefined) {
                    // Without discovery nothing else would learn of a topic that was created between the listing above and
                    // the metadata request inside subscribe(): the consumer is subscribed to it, but the listing lacks it,
                    // and a recovery would then leave it out. With discovery the first check handles it.
                    for (const name of await (await getAdmin()).listTopics()) {
                        if (!known.has(name) && wildcards.some((wildcard) => wildcard.test(name))) {
                            known.add(name);
                            started.add(name);
                        }
                    }
                }
                await consumer.run(runConfig);

                if (topicDiscoveryInterval !== undefined && wildcards.length > 0) {
                    stopDiscovery = startTopicDiscovery({
                        consumer: recovery.current,
                        serialize: recovery.serialize,
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
                await recovery.close().catch(() => undefined);
                throw err;
            }

            const handle: ConsumerHandle = { disconnect: () => recovery.close() };
            consumers.add(handle);

            return {
                async unsubscribe(): Promise<void> {
                    consumers.delete(handle);
                    if (stopDiscovery !== undefined) {
                        discoveryStops.delete(stopDiscovery);
                        await stopDiscovery();
                    }
                    for (const timer of resumeTimers) {
                        clearTimeout(timer);
                    }
                    resumeTimers.clear();
                    await recovery.close();
                },
            };
        },
    };
}

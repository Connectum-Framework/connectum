/**
 * Redis Streams adapter for @connectum/events.
 *
 * Uses Redis Streams (XADD, XREADGROUP, XACK) via ioredis
 * to provide durable, ordered event delivery with consumer groups.
 *
 * @module RedisAdapter
 */

import { randomUUID } from "node:crypto";
import type { EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import { Redis } from "ioredis";
import type { RedisAdapterOptions } from "./types.ts";

/**
 * Stream key prefix for event topics.
 *
 * Event type "user.created" becomes stream key "events:user.created".
 */
const STREAM_PREFIX = "events:";

/**
 * Default block timeout for XREADGROUP in milliseconds.
 */
const DEFAULT_BLOCK_MS = 5000;

/**
 * Default number of messages per XREADGROUP call.
 */
const DEFAULT_COUNT = 10;

/**
 * Retry delay on transient errors in the consume loop, in milliseconds.
 */
const ERROR_RETRY_DELAY_MS = 1000;

/**
 * Create a Redis Streams adapter for the Connectum event bus.
 *
 * The adapter uses Redis Streams with consumer groups for durable,
 * load-balanced event consumption. Each subscription creates a
 * dedicated blocking connection (via `redis.duplicate()`) to avoid
 * blocking the main connection used for publishing.
 *
 * @example
 * ```typescript
 * import { createEventBus } from "@connectum/events";
 * import { RedisAdapter } from "@connectum/events-redis";
 *
 * const bus = createEventBus({
 *     adapter: RedisAdapter({ url: "redis://localhost:6379" }),
 *     routes: [myEventRoutes],
 * });
 *
 * await bus.start();
 * ```
 */
export function RedisAdapter(options: RedisAdapterOptions = {}): EventAdapter {
    let redis: Redis | null = null;

    /**
     * Convert event type to Redis stream key.
     */
    function streamKey(eventType: string): string {
        return `${STREAM_PREFIX}${eventType}`;
    }

    /**
     * Create a Redis instance from adapter options.
     */
    function createRedisInstance(): Redis {
        if (options.url) {
            if (options.redisOptions) {
                return new Redis(options.url, options.redisOptions);
            }
            return new Redis(options.url);
        }
        if (options.redisOptions) {
            return new Redis(options.redisOptions);
        }
        return new Redis();
    }

    /**
     * Wait for a Redis connection to become ready.
     */
    async function waitForReady(instance: Redis): Promise<void> {
        // If already connected, return immediately
        if (instance.status === "ready") {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const onReady = () => {
                instance.removeListener("error", onError);
                resolve();
            };
            const onError = (err: Error) => {
                instance.removeListener("ready", onReady);
                reject(err);
            };
            instance.once("ready", onReady);
            instance.once("error", onError);
        });
    }

    /**
     * Parse flat field array from XREADGROUP into a Map.
     *
     * Redis returns fields as `["key1", "val1", "key2", "val2", ...]`.
     */
    function parseFields(fields: string[]): Map<string, string> {
        const map = new Map<string, string>();
        for (let i = 0; i < fields.length; i += 2) {
            const key = fields[i];
            const value = fields[i + 1];
            if (key !== undefined && value !== undefined) {
                map.set(key, value);
            }
        }
        return map;
    }

    /**
     * Extract user metadata from parsed fields.
     *
     * Metadata fields are stored with "meta:" prefix.
     */
    function extractMetadata(fieldMap: Map<string, string>): ReadonlyMap<string, string> {
        const metadata = new Map<string, string>();
        for (const [key, value] of fieldMap) {
            if (key.startsWith("meta:")) {
                metadata.set(key.slice(5), value);
            }
        }
        return metadata;
    }

    return {
        name: "redis",

        async connect(): Promise<void> {
            if (redis) {
                throw new Error("RedisAdapter: already connected");
            }
            redis = createRedisInstance();
            await waitForReady(redis);
        },

        async disconnect(): Promise<void> {
            if (redis) {
                await redis.quit();
                redis = null;
            }
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            if (!redis) {
                throw new Error("RedisAdapter: not connected");
            }

            const key = streamKey(eventType);
            const eventId = randomUUID();

            // Base64-encode binary payload to prevent UTF-8 corruption (C-3)
            const payloadBase64 = Buffer.from(payload).toString("base64");

            // Build XADD arguments via redis.call() for proper typing (W-5)
            const xaddArgs: string[] = [key];

            // Approximate MAXLEN trimming if configured
            const maxLen = options.brokerOptions?.maxLen;
            if (maxLen !== undefined) {
                xaddArgs.push("MAXLEN", "~", String(maxLen));
            }

            // Auto-generate stream entry ID
            xaddArgs.push("*");

            // Core field-value pairs
            xaddArgs.push("eventId", eventId, "eventType", eventType, "payload", payloadBase64, "publishedAt", new Date().toISOString());

            // User metadata as "meta:key" fields
            if (publishOptions?.metadata) {
                for (const [metaKey, metaValue] of Object.entries(publishOptions.metadata)) {
                    xaddArgs.push(`meta:${metaKey}`, metaValue);
                }
            }

            await redis.call("XADD", ...xaddArgs);
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!redis) {
                throw new Error("RedisAdapter: not connected");
            }

            const group = subOptions?.group ?? `connectum-${randomUUID()}`;
            const consumer = `consumer-${randomUUID()}`;
            const blockMs = options.brokerOptions?.blockMs ?? DEFAULT_BLOCK_MS;
            const count = options.brokerOptions?.count ?? DEFAULT_COUNT;

            // Map patterns to stream keys
            const streamKeys = patterns.map((p) => streamKey(p));

            // Ensure consumer groups exist for all streams
            for (const key of streamKeys) {
                try {
                    await redis.xgroup("CREATE", key, group, "$", "MKSTREAM");
                } catch (err: unknown) {
                    // BUSYGROUP means group already exists -- safe to ignore
                    if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) {
                        throw err;
                    }
                }
            }

            // Per-subscription running flag
            let subscriptionRunning = true;

            // Separate blocking connection for XREADGROUP
            const blockingRedis = redis.duplicate();
            await waitForReady(blockingRedis);

            // Background consumption loop
            const consumeLoop = async (): Promise<void> => {
                while (subscriptionRunning) {
                    try {
                        // XREADGROUP via redis.call() for proper typing (W-5)
                        const xreadArgs: string[] = [
                            "GROUP",
                            group,
                            consumer,
                            "COUNT",
                            String(count),
                            "BLOCK",
                            String(blockMs),
                            "STREAMS",
                            ...streamKeys,
                            ...streamKeys.map(() => ">"),
                        ];
                        const results = (await blockingRedis.call("XREADGROUP", ...xreadArgs)) as [string, [string, string[]][]][] | null;

                        if (!results) {
                            // Timeout with no messages -- loop continues
                            continue;
                        }

                        for (const [resultStreamKey, messages] of results) {
                            for (const [entryId, fields] of messages) {
                                const fieldMap = parseFields(fields);
                                const metadata = extractMetadata(fieldMap);

                                // Base64-decode binary payload (C-3)
                                const payloadStr = fieldMap.get("payload") ?? "";
                                const rawEvent: RawEvent = {
                                    eventId: fieldMap.get("eventId") ?? entryId,
                                    eventType: fieldMap.get("eventType") ?? "",
                                    payload: new Uint8Array(Buffer.from(payloadStr, "base64")),
                                    publishedAt: new Date(fieldMap.get("publishedAt") ?? Date.now()),
                                    attempt: 1,
                                    metadata,
                                };

                                // Real ack/nack wired through to EventBus (C-1)
                                const ack = async (): Promise<void> => {
                                    await blockingRedis.xack(resultStreamKey, group, entryId);
                                };
                                const nack = async (_requeue?: boolean): Promise<void> => {
                                    // Don't XACK -- message remains in pending entries list
                                    // and will be redelivered on next XREADGROUP
                                };

                                await handler(rawEvent, ack, nack);
                            }
                        }
                    } catch {
                        if (!subscriptionRunning) {
                            break;
                        }
                        // Transient error -- wait before retrying
                        await new Promise((resolve) => {
                            globalThis.setTimeout(resolve, ERROR_RETRY_DELAY_MS);
                        });
                    }
                }
            };

            // Start non-blocking (fire-and-forget)
            const loopPromise = consumeLoop();

            return {
                async unsubscribe(): Promise<void> {
                    subscriptionRunning = false;
                    await loopPromise.catch(() => {});
                    await blockingRedis.quit();
                },
            };
        },
    };
}

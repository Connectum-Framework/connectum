/**
 * Redis Streams adapter for @connectum/events.
 *
 * Uses Redis Streams (XADD, XREADGROUP, XACK) via ioredis
 * to provide durable, ordered event delivery with consumer groups.
 *
 * @module RedisAdapter
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
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
 * How often (in loop iterations) to attempt XAUTOCLAIM for stale pending entries.
 */
const PENDING_RECLAIM_INTERVAL = 5;

/**
 * Minimum idle time in milliseconds before a pending entry is reclaimed via XAUTOCLAIM.
 */
const PENDING_IDLE_MS = 30_000;

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

    /** Blocking reader connections created by subscribe(), tracked for cleanup. */
    const readers: Redis[] = [];

    /** Stop callbacks that set subscriptionRunning = false for each active subscription. */
    const stopCallbacks: (() => void)[] = [];

    /** Promises for active consume loops, awaited on disconnect. */
    const activeLoops: Promise<void>[] = [];

    /**
     * Convert event type to Redis stream key.
     */
    function streamKey(eventType: string): string {
        return `${STREAM_PREFIX}${eventType}`;
    }

    /**
     * Create a Redis instance from adapter options.
     *
     * @param connectionName - Optional connection name injected via `CLIENT SETNAME`.
     *   Only applied when the user has not set `redisOptions.connectionName`.
     */
    function createRedisInstance(connectionName?: string): Redis {
        // Merge connectionName into redisOptions only when the user has not
        // explicitly set it, preserving user-defined priority.
        const mergedRedisOptions = connectionName !== undefined && !options.redisOptions?.connectionName ? { ...options.redisOptions, connectionName } : options.redisOptions;

        if (options.url) {
            if (mergedRedisOptions) {
                return new Redis(options.url, mergedRedisOptions);
            }
            return new Redis(options.url);
        }
        if (mergedRedisOptions) {
            return new Redis(mergedRedisOptions);
        }
        return new Redis();
    }

    /**
     * Wait for a Redis connection to become ready.
     *
     * Handles `lazyConnect: true` — if the instance has not started
     * connecting yet (status "wait"), explicitly triggers connect()
     * before waiting for the "ready" event.
     */
    async function waitForReady(instance: Redis): Promise<void> {
        // If already connected, return immediately
        if (instance.status === "ready") {
            return;
        }

        // When lazyConnect is true, ioredis stays in "wait" status
        // until connect() is explicitly called. Trigger it so
        // the "ready" event will eventually fire.
        if (instance.status === "wait") {
            instance.connect().catch(() => {
                // Error will be emitted as "error" event and caught below
            });
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

        async connect(context?: AdapterContext): Promise<void> {
            if (redis) {
                throw new Error("RedisAdapter: already connected");
            }
            const instance = createRedisInstance(context?.serviceName);
            try {
                await waitForReady(instance);
            } catch (err) {
                // Connection failed — clean up the half-open client so the adapter
                // can be retried without being stuck in a broken state.
                instance.disconnect();
                throw err;
            }
            redis = instance;
        },

        async disconnect(): Promise<void> {
            // Signal all consume loops to stop.
            for (const stop of stopCallbacks) {
                stop();
            }

            // Interrupt blocking XREADGROUP by disconnecting readers.
            // disconnect() is synchronous and immediately tears down the socket,
            // causing pending XREADGROUP calls to reject and unblock the loop.
            for (const reader of readers) {
                reader.disconnect();
            }

            // Wait for all consume loops to exit.
            const loopResults = await Promise.allSettled(activeLoops);
            for (const r of loopResults) {
                if (r.status === "rejected") {
                    console.error("[RedisAdapter] consume loop error during disconnect:", r.reason);
                }
            }
            stopCallbacks.length = 0;
            activeLoops.length = 0;
            readers.length = 0;

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
                    xaddArgs.push(`meta:${metaKey}`, String(metaValue));
                }
            }

            await redis.call("XADD", ...xaddArgs);
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!redis) {
                throw new Error("RedisAdapter: not connected");
            }

            // Redis Streams does not support wildcard patterns.
            for (const p of patterns) {
                if (p.includes("*") || p.includes(">")) {
                    throw new Error(`RedisAdapter: wildcard pattern "${p}" is not supported. Redis Streams requires explicit topic names.`);
                }
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
            try {
                await waitForReady(blockingRedis);
            } catch (err) {
                blockingRedis.disconnect();
                throw err;
            }
            readers.push(blockingRedis);

            /**
             * Process a single stream message entry through the handler.
             */
            const processEntry = async (streamKeyForAck: string, entryId: string, fields: string[], attempt: number): Promise<void> => {
                const fieldMap = parseFields(fields);
                const metadata = extractMetadata(fieldMap);

                // Base64-decode binary payload (C-3)
                const payloadStr = fieldMap.get("payload") ?? "";

                const publishedAtRaw = fieldMap.get("publishedAt");
                const parsedDate = publishedAtRaw ? new Date(publishedAtRaw) : undefined;
                const publishedAt = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate : new Date();

                const rawEvent: RawEvent = {
                    eventId: fieldMap.get("eventId") ?? entryId,
                    eventType: fieldMap.get("eventType") ?? "",
                    payload: new Uint8Array(Buffer.from(payloadStr, "base64")),
                    publishedAt,
                    attempt,
                    metadata,
                };

                // Real ack/nack wired through to EventBus (C-1)
                const ack = async (): Promise<void> => {
                    await blockingRedis.xack(streamKeyForAck, group, entryId);
                };
                const nack = async (requeue?: boolean): Promise<void> => {
                    if (requeue === false) {
                        // "Reject without requeue" — XACK the message so it leaves the PEL
                        // and won't be redelivered. DLQ middleware already saved a copy. (M-4)
                        await blockingRedis.xack(streamKeyForAck, group, entryId);
                    }
                    // When requeue is true/undefined: don't XACK — message stays in PEL
                    // and XAUTOCLAIM will reclaim it for redelivery.
                };

                await handler(rawEvent, ack, nack);
            };

            /**
             * Reclaim stale pending entries via XAUTOCLAIM.
             *
             * Messages that were nack'd (not XACK'd) remain in the PEL.
             * XREADGROUP with `>` only delivers *new* messages, so without
             * this reclaim step nack'd messages would never be retried.
             */
            const reclaimPending = async (): Promise<void> => {
                for (const key of streamKeys) {
                    try {
                        // XAUTOCLAIM key group consumer min-idle-time start [COUNT count]
                        // Returns: [next-start-id, [[id, [fields...]], ...], [deleted-ids...]]
                        const result = (await blockingRedis.call("XAUTOCLAIM", key, group, consumer, String(PENDING_IDLE_MS), "0-0", "COUNT", String(count))) as
                            | [string, [string, string[]][], string[]]
                            | null;

                        if (!result) {
                            continue;
                        }

                        const [, entries] = result;
                        if (entries.length === 0) continue;

                        // Batch XPENDING: one round-trip instead of N (EFF-7).
                        const deliveryCounts = new Map<string, number>();
                        try {
                            const [firstId] = entries[0] as [string, string[]];
                            const [lastId] = entries[entries.length - 1] as [string, string[]];
                            const pendingAll = (await blockingRedis.call("XPENDING", key, group, firstId, lastId, String(entries.length))) as
                                | [string, string, number, number][]
                                | null;
                            if (pendingAll) {
                                for (const [entryId, , , deliveryCount] of pendingAll) {
                                    deliveryCounts.set(entryId, deliveryCount ?? 2);
                                }
                            }
                        } catch {
                            // XPENDING error is non-fatal — fall back to defaults
                        }

                        for (const [entryId, fields] of entries) {
                            if (!subscriptionRunning) {
                                return;
                            }
                            await processEntry(key, entryId, fields, deliveryCounts.get(entryId) ?? 2);
                        }
                    } catch (err) {
                        console.warn("[RedisAdapter] XAUTOCLAIM error (non-fatal):", err);
                    }
                }
            };

            // Background consumption loop
            const consumeLoop = async (): Promise<void> => {
                let iterationCount = 0;

                while (subscriptionRunning) {
                    try {
                        // Periodically reclaim stale pending entries (nack'd messages).
                        iterationCount += 1;
                        if (iterationCount % PENDING_RECLAIM_INTERVAL === 0) {
                            await reclaimPending();
                        }

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
                                try {
                                    await processEntry(resultStreamKey, entryId, fields, 1);
                                } catch (err) {
                                    console.error("[RedisAdapter] handler error for entry", entryId, err);
                                }
                            }
                        }
                    } catch (err) {
                        if (!subscriptionRunning) {
                            break;
                        }
                        console.error("[RedisAdapter] consume loop error, retrying in", ERROR_RETRY_DELAY_MS, "ms:", err);
                        // Transient error -- wait before retrying
                        await new Promise((resolve) => {
                            globalThis.setTimeout(resolve, ERROR_RETRY_DELAY_MS);
                        });
                    }
                }
            };

            // Start non-blocking (fire-and-forget)
            const loopPromise = consumeLoop();

            // Track stop callback and loop promise for disconnect().
            const stopCb = () => {
                subscriptionRunning = false;
            };
            stopCallbacks.push(stopCb);
            activeLoops.push(loopPromise);

            return {
                async unsubscribe(): Promise<void> {
                    subscriptionRunning = false;
                    // Interrupt blocking XREADGROUP so the loop exits promptly.
                    blockingRedis.disconnect();
                    await loopPromise.catch(() => {});

                    // Remove from tracked readers.
                    const readerIdx = readers.indexOf(blockingRedis);
                    if (readerIdx !== -1) {
                        readers.splice(readerIdx, 1);
                    }

                    // Remove from tracked stop callbacks and loop promises.
                    const stopIdx = stopCallbacks.indexOf(stopCb);
                    if (stopIdx !== -1) {
                        stopCallbacks.splice(stopIdx, 1);
                    }
                    const loopIdx = activeLoops.indexOf(loopPromise);
                    if (loopIdx !== -1) {
                        activeLoops.splice(loopIdx, 1);
                    }
                },
            };
        },
    };
}

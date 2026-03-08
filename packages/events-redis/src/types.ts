/**
 * Configuration types for the Redis Streams adapter.
 *
 * @module types
 */

import type { RedisOptions } from "ioredis";

/**
 * Options for creating a Redis Streams adapter.
 */
export interface RedisAdapterOptions {
    /**
     * Redis connection URL (e.g., "redis://localhost:6379").
     *
     * Takes precedence over `redisOptions.host` / `redisOptions.port`
     * when both are provided.
     */
    readonly url?: string;

    /**
     * Redis connection options (alternative to `url`).
     *
     * Passed directly to `new Redis(redisOptions)`.
     * When `url` is also set, these options are merged as the second argument.
     */
    readonly redisOptions?: RedisOptions;

    /**
     * Broker-specific tuning for Redis Streams consumption.
     */
    readonly brokerOptions?: RedisBrokerOptions;
}

/**
 * Redis Streams broker tuning options.
 */
export interface RedisBrokerOptions {
    /**
     * Maximum stream length (MAXLEN approximate for XADD).
     *
     * When set, older entries are trimmed on publish.
     *
     * @default undefined (no limit)
     */
    readonly maxLen?: number;

    /**
     * Block timeout in milliseconds for XREADGROUP.
     *
     * How long the consumer blocks waiting for new messages
     * before retrying the loop.
     *
     * @default 5000
     */
    readonly blockMs?: number;

    /**
     * Number of messages to read per XREADGROUP call.
     *
     * @default 10
     */
    readonly count?: number;
}

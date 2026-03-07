/**
 * @connectum/events-redis
 *
 * Redis Streams adapter for @connectum/events.
 *
 * Provides durable, ordered event delivery using Redis Streams
 * with consumer groups (XADD / XREADGROUP / XACK).
 *
 * @module @connectum/events-redis
 * @mergeModuleWith <project>
 */

export { RedisAdapter } from "./RedisAdapter.ts";
export type { RedisAdapterOptions, RedisBrokerOptions } from "./types.ts";

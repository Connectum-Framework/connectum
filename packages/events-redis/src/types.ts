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

    /** Connection lifecycle callback. Without it the adapter attaches no listener to the clients and behaves as before. */
    readonly lifecycle?: RedisLifecycleCallbacks;
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

/** Which client connection of the adapter an event concerns. */
export type RedisLifecycleConnection =
    | "publisher"
    | {
          /** The dedicated blocking connection of one subscription. */
          readonly group: string;
          readonly patterns: readonly string[];
      };

/**
 * Connection lifecycle events of the Redis adapter, delivered to {@link RedisLifecycleCallbacks.onLifecycle}.
 *
 * A discriminated union on `type`. The strings and the shared fields match the AMQP adapter's events;
 * the type is local to this package. The adapter holds one publishing connection and one blocking
 * connection per subscription, so one broker loss is reported once per connection (`connection` says which).
 */
export type RedisLifecycleEvent =
    | {
          /** A connection became ready: for the first time (`reconnected: false`) or after a loss (`reconnected: true`). */
          readonly type: "connected";
          readonly reconnected: boolean;
          readonly connection: RedisLifecycleConnection;
      }
    | {
          /** A connection that had been ready was lost; the client retries on its own. Once per loss, however many attempts fail. Not delivered for the adapter's own close. */
          readonly type: "disconnected";
          readonly error: Error;
          readonly connection: RedisLifecycleConnection;
      }
    | {
          /** The client scheduled a reconnect attempt after `delay` milliseconds; `attempt` counts them since the loss. */
          readonly type: "reconnecting";
          readonly attempt: number;
          readonly delay: number;
          readonly error: Error;
          readonly connection: RedisLifecycleConnection;
      }
    | {
          /** Terminal: the client ended without the adapter closing it (a retry strategy that returned no delay). */
          readonly type: "reconnect-failed";
          readonly error: Error;
          readonly connection: RedisLifecycleConnection;
      }
    | {
          /**
           * Redis lost a consumer group (data loss, failover to a replica without the stream) and the subscription created it again.
           * The group starts at the beginning of the stream, so entries it had already handled before the loss can be delivered a second time.
           */
          readonly type: "group-recreated";
          readonly group: string;
          /** The stream key, `events:<topic>`. */
          readonly stream: string;
          readonly connection: Exclude<RedisLifecycleConnection, "publisher">;
      }
    | {
          /** A lifecycle callback threw or returned a rejected promise. */
          readonly type: "lifecycle-error";
          readonly callback: string;
          readonly event: string;
          readonly error: Error;
      };

/** Callbacks for the connection lifecycle of the Redis adapter. */
export interface RedisLifecycleCallbacks {
    /**
     * Called for every {@link RedisLifecycleEvent}. It should not throw: a thrown exception or a
     * rejected returned promise is isolated and reported as a `lifecycle-error` event, and a failure
     * while handling that one is dropped. A returned promise is not awaited.
     *
     * Setting it attaches an `error` listener to every connection, which replaces the client's own
     * "Unhandled error event" line on stderr; the cause is carried by the `error` field of the events instead.
     */
    readonly onLifecycle?: (event: RedisLifecycleEvent) => void | Promise<void>;
}

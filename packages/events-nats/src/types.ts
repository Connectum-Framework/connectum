/**
 * Configuration types for the NATS JetStream adapter.
 *
 * @module types
 */

import type { NodeConnectionOptions } from "@nats-io/transport-node";

/**
 * Options for creating a NATS JetStream adapter.
 */
export interface NatsAdapterOptions {
    /** NATS server URL(s). Accepts a single string or an array. */
    readonly servers: string | string[];

    /**
     * JetStream stream name.
     *
     * When set, subjects are prefixed with `{stream}.` and the stream
     * is auto-created on `connect()` if it does not exist.
     *
     * @default "events"
     */
    readonly stream?: string;

    /**
     * NATS connection options (escape hatch for advanced config).
     *
     * The `servers` field from this object is overridden by the
     * top-level `servers` option.
     */
    readonly connectionOptions?: Partial<NodeConnectionOptions>;

    /** JetStream consumer tuning options. */
    readonly consumerOptions?: NatsConsumerOptions;
}

/**
 * Options for JetStream consumer behaviour.
 */
export interface NatsConsumerOptions {
    /**
     * Deliver policy for new consumers.
     * - `"new"` — only messages published after consumer creation
     * - `"all"` — all available messages
     * - `"last"` — last message per subject
     *
     * @default "new"
     */
    readonly deliverPolicy?: "new" | "all" | "last";

    /**
     * Ack wait timeout in milliseconds.
     * After this period an unacknowledged message is redelivered.
     *
     * @default 30_000
     */
    readonly ackWait?: number;

    /**
     * Maximum number of delivery attempts before the message
     * is discarded by the server.
     *
     * @default 5
     */
    readonly maxDeliver?: number;
}

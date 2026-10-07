/**
 * Configuration types for the Kafka event adapter.
 *
 * @module types
 */

import type { CompressionTypes, KafkaConfig } from "kafkajs";

/**
 * Options for creating a KafkaAdapter instance.
 */
export interface KafkaAdapterOptions {
    /** Kafka broker addresses (e.g., ["localhost:9092"]) */
    readonly brokers: string[];

    /** Client ID for this producer/consumer (default: "connectum") */
    readonly clientId?: string;

    /**
     * Additional KafkaJS configuration overrides.
     * Merged with brokers and clientId.
     */
    readonly kafkaConfig?: Omit<Partial<KafkaConfig>, "brokers" | "clientId">;

    /** Producer-specific options */
    readonly producerOptions?: {
        /** Compression type for produced messages */
        readonly compression?: CompressionTypes;
    };

    /** Consumer-specific options */
    readonly consumerOptions?: {
        /** Session timeout in milliseconds (default: 30000) */
        readonly sessionTimeout?: number;
        /** Whether to start consuming from the beginning of topics (default: false) */
        readonly fromBeginning?: boolean;
        /** Whether Kafka should auto-create topics on subscribe (default: false) */
        readonly allowAutoTopicCreation?: boolean;
        /**
         * Milliseconds to wait before a message that was not committed is delivered again
         * (default: 1000).
         *
         * A message stays uncommitted when the handler throws, calls `nack()` (requeue) or
         * returns without settling it. Kafka offers no per-message redelivery timer, so the
         * adapter pauses the affected partition for this long before the redelivery. `0`
         * disables the pause: the same message is then fetched and handled again at network
         * speed until it succeeds, is dead-lettered or is rejected with `nack(false)`.
         *
         * The pause only paces the redelivery loop; it does not end it. On an otherwise idle
         * consumer the observed gap is a whole fetch cycle (5 s in KafkaJS) even for smaller
         * values. Must be between 0 and 2147483647 (the longest delay a Node.js timer
         * supports); `KafkaAdapter()` throws a `RangeError` otherwise.
         */
        readonly redeliveryDelay?: number;
        /**
         * When the consumer group's offset is committed to the broker (default: `"per-message"`).
         *
         * - `"per-message"`: every acknowledged message is committed by its own `OffsetCommit`
         *   request, and `await ack()` returns once the broker has accepted it. A batch of 20
         *   acknowledged messages costs 20 requests.
         * - `"per-batch"`: `ack()` only remembers the message; one `OffsetCommit` for the last
         *   acknowledged message is sent when the adapter stops working on the batch — at its
         *   end, at a requeued or unsettled message, when the handler throws, when the consumer
         *   stops, and when the group membership is lost. Acknowledged messages are never left
         *   uncommitted on any of these exits, and an unsettled message is never committed.
         *
         * The price of `"per-batch"` is the window of duplicates. If the process dies (or the
         * broker refuses the commit) between an `ack()` and the end of the batch, every message
         * acknowledged in that batch is delivered again, up to the size of the batch, instead of at
         * most one. Handlers must be idempotent, and a dead-letter copy published before the
         * original is acknowledged can be published twice. `await ack()` no longer means the
         * offset is durable. The delivery guarantee stays at-least-once.
         *
         * `KafkaAdapter()` throws a `RangeError` for any other value.
         */
        readonly commitStrategy?: "per-message" | "per-batch";
    };
}

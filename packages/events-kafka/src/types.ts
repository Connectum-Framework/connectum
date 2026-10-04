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
         * (default: 0 — delivered again immediately).
         *
         * A message stays uncommitted when the handler throws, calls `nack()` (requeue) or
         * returns without settling it. Kafka offers no per-message redelivery timer, so with
         * the default the same message is fetched and handled again at network speed until it
         * succeeds, is dead-lettered or is rejected with `nack(false)`. A positive value pauses
         * the affected partition for that long before the redelivery. Must be between 0 and
         * 2147483647 (the longest delay a Node.js timer supports); `KafkaAdapter()` throws a
         * `RangeError` otherwise.
         */
        readonly redeliveryDelay?: number;
    };
}

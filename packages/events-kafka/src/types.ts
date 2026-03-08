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
    };
}

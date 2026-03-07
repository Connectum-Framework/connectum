/**
 * @connectum/events-kafka
 *
 * Kafka/Redpanda adapter for @connectum/events.
 *
 * Provides a KafkaJS-based EventAdapter implementation for
 * production message broker integration with Apache Kafka
 * or Redpanda-compatible brokers.
 *
 * @module @connectum/events-kafka
 * @mergeModuleWith <project>
 */

export { KafkaAdapter } from "./KafkaAdapter.ts";
export type { KafkaAdapterOptions } from "./types.ts";

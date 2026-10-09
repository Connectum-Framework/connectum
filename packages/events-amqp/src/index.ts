/**
 * @connectum/events-amqp
 *
 * AMQP/RabbitMQ adapter for the `@connectum/events` event bus.
 *
 * Provides AMQP 0-9-1 (RabbitMQ) publishing and consumption with topic
 * exchanges, consumer groups via named queues,
 * dead-letter exchange support, and metadata propagation
 * via message headers.
 * Delivery and retention depend on broker topology and publish settings:
 * unroutable publishes are detected only when `publisherOptions.mandatory`
 * is enabled, and subscriptions without a named group use private,
 * non-durable, auto-delete queues.
 *
 * @example
 * ```typescript
 * import { AmqpAdapter } from "@connectum/events-amqp";
 * import { createEventBus } from "@connectum/events";
 *
 * const bus = createEventBus({
 *     adapter: AmqpAdapter({ url: "amqp://guest:guest@localhost:5672" }),
 *     routes: [myRoutes],
 * });
 * await bus.start();
 * ```
 *
 * @module @connectum/events-amqp
 * @mergeModuleWith <project>
 */

export { AmqpAdapter, isAutoRetriablePublishError, toAmqpPattern } from "./AmqpAdapter.ts";
export type { AmqpTopologyObject } from "./errors.ts";
export { AmqpAdapterError, AmqpConnectionError, AmqpPublishNackError, AmqpPublishTimeoutError, AmqpSerializationError, AmqpTopologyError, AmqpUnroutableError } from "./errors.ts";
export type {
    AmqpAdapterOptions,
    AmqpBindingDeclaration,
    AmqpConsumerLossCause,
    AmqpConsumerOptions,
    AmqpExchangeDeclaration,
    AmqpExchangeOptions,
    AmqpLifecycleCallbacks,
    AmqpLifecycleEvent,
    AmqpPublisherOptions,
    AmqpPublishRetryOptions,
    AmqpQueueDeclaration,
    AmqpQueueOptions,
    AmqpQueueOverride,
    AmqpRecoveryOptions,
    AmqpSerializationOptions,
    AmqpSettlementAction,
    AmqpTopology,
} from "./types.ts";
export { AmqpTopologyMode } from "./types.ts";

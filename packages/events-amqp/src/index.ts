/**
 * @connectum/events-amqp
 *
 * AMQP/RabbitMQ adapter for the `@connectum/events` event bus.
 *
 * Provides at-least-once delivery through AMQP 0-9-1 (RabbitMQ)
 * with topic exchanges, consumer groups via named queues,
 * dead-letter exchange support, and metadata propagation
 * via message headers.
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

export { AmqpAdapter, toAmqpPattern } from "./AmqpAdapter.ts";
export type {
    AmqpAdapterOptions,
    AmqpConsumerOptions,
    AmqpExchangeOptions,
    AmqpPublisherOptions,
    AmqpQueueOptions,
} from "./types.ts";

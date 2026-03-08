/**
 * @connectum/events-nats
 *
 * NATS JetStream adapter for the `@connectum/events` event bus.
 *
 * Provides persistent at-least-once delivery through NATS JetStream
 * with durable consumers, wildcard routing, and metadata propagation
 * via NATS headers.
 *
 * @example
 * ```typescript
 * import { NatsAdapter } from "@connectum/events-nats";
 * import { createEventBus } from "@connectum/events";
 *
 * const bus = createEventBus({
 *     adapter: NatsAdapter({ servers: "nats://localhost:4222" }),
 *     routes: [myRoutes],
 * });
 * await bus.start();
 * ```
 *
 * @module @connectum/events-nats
 * @mergeModuleWith <project>
 */

export { NatsAdapter } from "./NatsAdapter.ts";
export type { NatsAdapterOptions, NatsConsumerOptions } from "./types.ts";

/**
 * Type definitions for the event adapter layer.
 *
 * @module types
 */

import type { DescMessage, DescMethod, DescService, MessageShape } from "@bufbuild/protobuf";

// =============================================================================
// ADAPTER INTERFACE
// =============================================================================

/**
 * Raw event data delivered by the adapter
 */
export interface RawEvent {
    /** Unique event identifier */
    readonly eventId: string;
    /** Event type / topic name */
    readonly eventType: string;
    /** Serialized protobuf payload */
    readonly payload: Uint8Array;
    /** When the event was published */
    readonly publishedAt: Date;
    /** Delivery attempt number (1-based) */
    readonly attempt: number;
    /** Event metadata (headers) */
    readonly metadata: ReadonlyMap<string, string>;
}

/**
 * Raw event handler function type.
 *
 * Adapters call this with the deserialized event and broker-specific
 * ack/nack callbacks. The EventBus wires these into the EventContext
 * for end-user handlers.
 */
export type RawEventHandler = (event: RawEvent, ack: () => Promise<void>, nack: (requeue?: boolean) => Promise<void>) => Promise<void>;

/**
 * Subscription handle returned by adapter.subscribe()
 */
export interface EventSubscription {
    /** Unsubscribe and clean up */
    unsubscribe(): Promise<void>;
}

/**
 * Options for raw subscribe
 */
export interface RawSubscribeOptions {
    /**
     * Consumer group name for load-balanced consumption.
     *
     * Without it the adapter picks a new random group for every subscription.
     * With Kafka and Redis Streams that group has no committed position, so a
     * restarted process starts at the end of the stream and never sees the events
     * published while it was down; give the subscription an explicit `group` to
     * keep its position across restarts.
     */
    group?: string;
}

/**
 * Options for publishing events
 */
export interface PublishOptions {
    /** Override topic name (default: schema.typeName) */
    topic?: string;
    /** Named group tag for workflow grouping */
    group?: string;
    /** Additional metadata / headers */
    metadata?: Record<string, string>;
    /** Message key for partitioning (Kafka: partition key, others: ignored) */
    key?: string;
    /**
     * Caller-supplied message identifier the adapter sets on the wire where
     * supported (AMQP: the `messageId` property; other adapters ignore it).
     * Primarily for external-contract publishing — in `@connectum/events-amqp`
     * `externalContract` mode the adapter does not auto-generate a `messageId`,
     * so set this when the contract requires one.
     */
    messageId?: string;
    /**
     * Caller-supplied message timestamp in **Unix epoch seconds**, set on the
     * wire where supported (AMQP: the `timestamp` property; other adapters
     * ignore it). Like {@link messageId}, mainly for external-contract
     * publishing where the adapter does not auto-populate it.
     */
    timestamp?: number;
}

/**
 * Context provided to adapters by the EventBus before connect().
 *
 * Contains service-level information derived from registered proto
 * service descriptors. Adapters may use this for broker-level
 * identification (e.g., Kafka clientId, NATS connection name,
 * Redis connectionName).
 */
export interface AdapterContext {
    /**
     * Service identifier derived from proto service names.
     *
     * Format: `{packageNames}@{hostname}`
     *
     * Examples:
     * - `"order.v1@pod-abc123"` (single service)
     * - `"order.v1/payment.v1@pod-abc123"` (multiple services)
     */
    readonly serviceName?: string;
}

/**
 * Minimal adapter interface for message brokers.
 *
 * Inspired by Watermill (Go): minimal surface, broker-specific
 * config in constructor, not in interface methods.
 */
export interface EventAdapter {
    /** Adapter name for identification (e.g., "nats", "kafka", "redis", "memory") */
    readonly name: string;

    /**
     * Connect to the message broker.
     *
     * @param context - Optional adapter context with service-level information
     *   derived from proto service descriptors. Adapters may use
     *   `context.serviceName` for broker-level client identification.
     */
    connect(context?: AdapterContext): Promise<void>;

    /** Disconnect from the message broker */
    disconnect(): Promise<void>;

    /** Publish a serialized event to a topic */
    publish(eventType: string, payload: Uint8Array, options?: PublishOptions): Promise<void>;

    /** Subscribe to event patterns with a raw handler */
    subscribe(patterns: string[], handler: RawEventHandler, options?: RawSubscribeOptions): Promise<EventSubscription>;
}

/**
 * A zero-argument factory producing a fresh {@link EventAdapter}.
 *
 * Used where each consumer needs its OWN broker connection — e.g.
 * `createBroadcastSubscribers` invokes it once per reactor so every reactor
 * bus gets an independent connection / durable consumer.
 *
 * DI guidance: for wiring a service, prefer injecting an `EventAdapter`
 * INSTANCE (constructed at the composition root) — a test double with its own
 * configuration does not fit a zero-argument factory signature without a
 * wrapper closure. Reach for the factory only where per-consumer connections
 * are the point. Since 1.3.0.
 */
export type EventAdapterFactory = () => EventAdapter;

// =============================================================================
// EVENT CONTEXT
// =============================================================================

/**
 * Per-event context with explicit ack/nack control.
 *
 * Passed to event handlers alongside the deserialized message.
 * Supports explicit ack/nack control. If the handler completes
 * without calling either, the event is automatically acknowledged.
 */
export interface EventContext {
    /** Abort signal (aborted when server is shutting down) */
    readonly signal: AbortSignal;
    /** Unique event identifier */
    readonly eventId: string;
    /** Event type / topic name */
    readonly eventType: string;
    /** When the event was published */
    readonly publishedAt: Date;
    /** Delivery attempt number (1-based) */
    readonly attempt: number;
    /** Event metadata (headers) */
    readonly metadata: ReadonlyMap<string, string>;
    /** Acknowledge successful processing */
    ack(): Promise<void>;
    /** Negative acknowledge -- request redelivery or send to DLQ */
    nack(requeue?: boolean): Promise<void>;
    /**
     * Publish an event on behalf of this delivery: the way a relay handler (consume, transform,
     * publish) hands its result on.
     *
     * While the bus is stopping, `bus.publish` is refused, but this call is still admitted as long
     * as the handler of this delivery has not returned and the drain has not been aborted, and
     * `stop()` waits for it before the adapter is disconnected. The right belongs to this one
     * delivery, this bus and this start/stop cycle: it ends when the handler's promise settles,
     * when the drain is aborted, and when the bus stops; a call after that is rejected. Await the
     * result inside the handler, so a failed publish fails the handler and the message is retried.
     *
     * Handlers that publish through an injected bus instead of `ctx` keep being refused during
     * `stop()`; rewrite them to use `ctx.publish` to relay during shutdown.
     */
    publish<Desc extends DescMessage>(schema: Desc, data: MessageShape<Desc>, options?: PublishOptions): Promise<void>;
}

/**
 * Initialization data for creating an EventContext
 */
export interface EventContextInit {
    readonly raw: RawEvent;
    readonly signal: AbortSignal;
    readonly onAck: () => Promise<void>;
    readonly onNack: (requeue: boolean) => Promise<void>;
    /** Implementation of `ctx.publish`; a context built without one rejects every publish. */
    readonly publish?: EventContext["publish"];
}

// =============================================================================
// EVENT ROUTER
// =============================================================================

/**
 * Typed event handler for a specific message type
 */
export type TypedEventHandler<I> = (event: I, ctx: EventContext) => Promise<void>;

/**
 * Per-handler middleware configuration.
 *
 * Overrides global EventBus middleware for this specific handler.
 * When present, the global middleware pipeline is bypassed entirely
 * and only the per-handler middleware array is applied.
 */
export interface EventHandlerConfig<I> {
    /** Event handler function */
    readonly handler: TypedEventHandler<I>;
    /** Per-handler middleware array (overrides global middleware for this handler) */
    readonly middleware?: EventMiddleware[];
}

/**
 * Maps service methods to typed event handlers.
 *
 * Each handler can be either:
 * - A simple function (uses global middleware)
 * - An object with `handler` and optional `middleware` (per-handler override)
 */
export type ServiceEventHandlers<S extends DescService> = {
    [K in keyof S["method"]]: TypedEventHandler<MessageShape<S["method"][K]["input"]>> | EventHandlerConfig<MessageShape<S["method"][K]["input"]>>;
};

/**
 * Registered event route (internal use)
 */
export interface EventRouteEntry {
    /** Topic pattern to subscribe to */
    readonly topic: string;
    /** Method descriptor for deserialization */
    readonly method: DescMethod;
    /** Typed handler function */
    readonly handler: TypedEventHandler<unknown>;
    /** Per-handler middleware (overrides global when present) */
    readonly middleware?: EventMiddleware[];
}

/**
 * Event router for registering service event handlers.
 *
 * Mirrors ConnectRPC's ConnectRouter pattern:
 * `events.service(UserEventHandlers, { ... })` mirrors `router.service(UserService, { ... })`
 */
export interface EventRouter {
    /** Register event handlers for a service */
    service<S extends DescService>(serviceDesc: S, handlers: ServiceEventHandlers<S>): void;
}

/**
 * Event route function -- mirrors ServiceRoute from @connectum/core
 */
export type EventRoute = (events: EventRouter) => void;

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Event middleware next function.
 *
 * Optionally accepts an updated event to replace the current one
 * in the pipeline (e.g., retry middleware sets a new attempt number
 * without mutating the readonly original).
 */
export type EventMiddlewareNext = (updatedEvent?: RawEvent) => Promise<void>;

/**
 * Event middleware function
 */
export type EventMiddleware = (event: RawEvent, ctx: EventContext, next: EventMiddlewareNext) => Promise<void>;

// =============================================================================
// EVENT BUS
// =============================================================================

/**
 * Retry middleware options
 */
export interface RetryOptions {
    /**
     * Maximum number of retries after the first attempt: an integer of at least 0 (default: 3).
     * `0` runs the handler once. Any other value (negative, fractional, `NaN`, infinite) makes
     * `retryMiddleware` throw when it is created.
     */
    maxRetries?: number;
    /** Backoff strategy */
    backoff?: "exponential" | "linear" | "fixed";
    /** Initial delay in ms (default: 1000) */
    initialDelay?: number;
    /** Maximum delay in ms (default: 30000) */
    maxDelay?: number;
    /** Multiplier for exponential backoff (default: 2) */
    multiplier?: number;
    /** Filter: only retry for these error types */
    retryableErrors?: (error: unknown) => boolean;
}

/**
 * Dead letter queue middleware options
 */
export interface DlqOptions {
    /**
     * DLQ topic name: a non-empty string. Anything else (a missing or empty value, a non-string)
     * makes `createEventBus` and `dlqMiddleware` throw when they are created, because every failed
     * event would otherwise be lost. Whether the broker accepts the name is decided by the adapter
     * at the first publish; a rejected publish is reported as a `dlq-failed` observer event.
     */
    topic: string;
    /**
     * Custom error serializer for DLQ metadata.
     * Defaults to `error.name` only (e.g. "TypeError") to prevent credential leaks.
     * For production, provide a custom serializer that redacts sensitive data
     * (connection strings, tokens) before including error details.
     */
    errorSerializer?: (error: unknown) => string;
}

/**
 * Built-in middleware configuration
 */
export interface MiddlewareConfig {
    /** Retry configuration */
    retry?: RetryOptions;
    /** Dead letter queue configuration */
    dlq?: DlqOptions;
    /** Custom user middleware (executed outermost) */
    custom?: EventMiddleware[];
}

/**
 * Work the shutdown of an {@link EventBus} gave up on.
 *
 * `abandoned` is reported once per `stop()`, only when something was left: `handlers` is the
 * number of handlers still running when `drainAbortGrace` ran out (all of them were aborted, none
 * returned), `publishes` the number of `publish()` calls still unsettled when `drainPublishTimeout`
 * ran out. The event reports work that was still unsettled when `stop()` abandoned it; it does not
 * say that a message was left unacknowledged (a handler may have acknowledged before it got stuck)
 * or that the broker will redeliver it.
 */
export type EventBusObserverEvent =
    | {
          readonly type: "abandoned";
          readonly handlers: number;
          readonly publishes: number;
      }
    /** A `ctx.publish` made while the bus was stopping was admitted. */
    | { readonly type: "admitted"; readonly topic: string }
    /**
     * A `ctx.publish` made while the bus was stopping was refused: `aborted` (the drain was
     * aborted), `not-in-flight` (its handler had already returned, or the context belongs to an
     * earlier start/stop cycle).
     */
    | { readonly type: "rejected"; readonly reason: "aborted" | "not-in-flight" }
    /** The built-in dead-letter middleware republished a failed event while the bus was stopping. */
    | { readonly type: "dlq-republish"; readonly topic: string }
    /**
     * The built-in dead-letter middleware could not publish a failed event to its topic, at any
     * time, not only during a stop. The original is nacked without requeue and, unless the broker
     * has its own dead-letter policy, lost. `topic` is the dead-letter topic, `eventType` and
     * `eventId` identify the event, `error` is what the publish rejected with (it can carry broker
     * details, so redact it before logging it outside your service).
     */
    | { readonly type: "dlq-failed"; readonly topic: string; readonly eventType: string; readonly eventId: string; readonly error: unknown };

/** Callback for {@link EventBusObserverEvent}; see `EventBusOptions.observer`. */
export type EventBusObserver = (event: EventBusObserverEvent) => void | Promise<void>;

/**
 * EventBus configuration options for createEventBus()
 */
export interface EventBusOptions {
    /** Adapter instance (e.g., NatsAdapter, KafkaAdapter, MemoryAdapter) */
    adapter: EventAdapter;
    /** Event routes to register */
    routes?: EventRoute[];
    /**
     * Event service descriptors this bus publishes to (publish-only, no subscription).
     *
     * A process that only PUBLISHES events has no `routes`, so its publish-topic
     * lookup would be empty and `publish()` would fall back to the message
     * `typeName` — silently emitting to the wrong topic whenever the event
     * declares a custom `(connectum.events.v1.event).topic`. List the event
     * service descriptors here to populate the publish-topic lookup from their
     * proto options, so the declared topic is used end-to-end without
     * hand-maintaining raw topic strings. Subscribers still register via `routes`.
     */
    publishes?: DescService[];
    /**
     * Consumer group name, passed to every subscription of this bus.
     *
     * When omitted, the adapter picks a new random group per subscription. With
     * Kafka that group (`connectum-<uuid>`) has no committed offset and
     * `consumerOptions.fromBeginning` is `false` by default, so after a restart the
     * events published during the downtime are not delivered. Set an explicit
     * `group` for a subscription that must not lose them.
     */
    group?: string;
    /** Middleware configuration */
    middleware?: MiddlewareConfig;
    /**
     * Abort signal for graceful shutdown.
     *
     * When provided, per-event signals are composed via `AbortSignal.any()`
     * so that server shutdown aborts in-flight event processing.
     * Automatically set when used with `createServer({ eventBus })`.
     */
    signal?: AbortSignal;
    /**
     * Per-event handler timeout in milliseconds.
     *
     * Each event handler invocation gets an AbortSignal that fires after
     * this duration. Default: 30000 (30 seconds).
     */
    handlerTimeout?: number;
    /**
     * Maximum time in milliseconds to wait for in-flight event handlers
     * to complete during shutdown. After this timeout, remaining handlers
     * are force-aborted via AbortSignal.
     *
     * Default: 30000 (30 seconds). Set to 0 for immediate abort.
     */
    drainTimeout?: number;
    /**
     * Maximum time in milliseconds `stop()` keeps waiting for handlers that are still running
     * AFTER `drainTimeout` expired and they were force-aborted. A handler that ignores the abort
     * signal is then abandoned: `stop()` goes on to disconnect the adapter without waiting for
     * the adapter to close the subscription of a handler that is still running, and the observer
     * is told (`abandoned`). The abandoned handler's later acknowledgement may fail (the
     * adapter contract does not say); whether its message is delivered again is up to the
     * broker and to whether the handler had already acknowledged it.
     *
     * Total shutdown budget of the bus: `drainTimeout` + `drainAbortGrace` (the handler phase;
     * the publish drain runs concurrently with it), plus whatever the transport phase of
     * `createServer`'s `shutdown.timeout` took before. Compare the sum with the kill grace period
     * of your orchestrator.
     *
     * Default: `undefined` — the wait after the abort has no limit, as before: a handler that
     * never returns holds `stop()` forever. There is no default number because the time handlers
     * need to finish after an abort has not been measured. `0` abandons at once after the abort.
     * Must be a finite, non-negative number; anything else (negative, `NaN`, `Infinity`) throws a
     * `RangeError` from `createEventBus`; leave it unset for an unbounded wait.
     */
    drainAbortGrace?: number;
    /**
     * Receives what the shutdown could not finish and a failed dead-letter publish, see
     * {@link EventBusObserverEvent}. Called synchronously by the code that reports (`stop()`, or
     * the dead-letter middleware); an error thrown by it (or a promise it returns that rejects)
     * is swallowed, because reporting must never prevent the adapter from being disconnected or
     * change what happens to the event.
     */
    observer?: EventBusObserver;
    /**
     * Opt-in symmetric publish drain during `stop()`: maximum time in
     * milliseconds to wait for in-flight `publish()` promises (started BEFORE
     * `stop()` was called) to settle, before the adapter is disconnected.
     *
     * Runs concurrently with the handler drain (`drainTimeout`) — shutdown
     * waits for the slower of the two, not their sum. Tracked promises carry
     * a no-op observer, so a publish that settles (even rejects) after the
     * deadline never becomes an `unhandledRejection`; the caller's own
     * `publish()` promise is unaffected (rejections still propagate to it).
     *
     * NOT covered: publishes issued from inside handlers (including the DLQ
     * republish) — those are governed by the handler drain and its post-abort
     * settle window; new `publish()` calls after `stop()` begins are rejected
     * by the stopping gate; handler-originated publishes are covered only by
     * the handler drain and its post-abort settlement window.
     *
     * Budget note: `createServer`'s `shutdown.timeout` bounds the transport
     * phase, not the shutdown hooks that stop the bus — a large value here
     * extends total process shutdown accordingly; size it below your
     * orchestrator's kill grace period.
     *
     * Default: `undefined` — disabled: `stop()` behavior is unchanged and
     * in-flight publishes race the adapter disconnect exactly as before.
     * `0` (or negative) also disables waiting. Available since 1.3.0.
     */
    drainPublishTimeout?: number;
    /**
     * Reject a `publish()` whose topic cannot be resolved instead of silently
     * falling back to the message `typeName`.
     *
     * By default, when no explicit `publishOptions.topic` is given and the event
     * type is covered by neither `routes` nor `publishes`, `publish()` emits to
     * the raw `schema.typeName` — a silent misconfiguration (the event may never
     * reach subscribers expecting the proto-declared `(event).topic`). With
     * `strictTopics: true`, that case throws so the misconfiguration surfaces at
     * the call site.
     *
     * Default: `false` (backward-compatible silent fallback).
     */
    strictTopics?: boolean;
}

/**
 * EventBus interface -- manages adapter, routes, and middleware
 */
export interface EventBus {
    /**
     * Start the event bus: connect adapter, set up subscriptions.
     *
     * An optional `signal` can be passed for graceful shutdown.
     * If provided, it **overrides** the construction-time `EventBusOptions.signal`.
     * The active signal is then composed with `AbortSignal.timeout(handlerTimeout)`
     * via `AbortSignal.any()` for each event handler invocation, so either
     * shutdown or per-event timeout will abort in-flight processing.
     */
    start(options?: { signal?: AbortSignal }): Promise<void>;
    /** Stop the event bus: drain subscriptions, disconnect adapter */
    stop(): Promise<void>;
    /** Publish a typed event */
    publish<Desc extends DescMessage>(schema: Desc, data: MessageShape<Desc>, options?: PublishOptions): Promise<void>;
}

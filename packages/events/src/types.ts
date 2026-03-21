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
    /** Consumer group name for load-balanced consumption */
    group?: string;
}

/**
 * Options for publishing events
 */
export interface PublishOptions {
    /** Override topic name (default: schema.typeName) */
    topic?: string;
    /** Wait for broker confirmation (default: false = fire-and-forget) */
    sync?: boolean;
    /** Named group tag for workflow grouping */
    group?: string;
    /** Additional metadata / headers */
    metadata?: Record<string, string>;
    /** Message key for partitioning (Kafka: partition key, others: ignored) */
    key?: string;
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
}

/**
 * Initialization data for creating an EventContext
 */
export interface EventContextInit {
    readonly raw: RawEvent;
    readonly signal: AbortSignal;
    readonly onAck: () => Promise<void>;
    readonly onNack: (requeue: boolean) => Promise<void>;
}

// =============================================================================
// EVENT ROUTER
// =============================================================================

/**
 * Typed event handler for a specific message type
 */
export type TypedEventHandler<I> = (event: I, ctx: EventContext) => Promise<void>;

/**
 * Maps service methods to typed event handlers.
 *
 * Conditional type: for each method in the service descriptor,
 * creates a handler expecting the method's input type.
 */
export type ServiceEventHandlers<S extends DescService> = {
    [K in S["methods"][number] as K["localName"]]: TypedEventHandler<MessageShape<K["input"]>>;
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
    /** Maximum retry attempts (default: 3) */
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
    /** DLQ topic name */
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
 * EventBus configuration options for createEventBus()
 */
export interface EventBusOptions {
    /** Adapter instance (e.g., NatsAdapter, KafkaAdapter, MemoryAdapter) */
    adapter: EventAdapter;
    /** Event routes to register */
    routes?: EventRoute[];
    /** Consumer group name */
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

/**
 * @connectum/events
 *
 * Universal event adapter layer for Connectum.
 *
 * Provides proto-first pub/sub with pluggable broker adapters:
 * - createEventBus(): Factory for event bus with adapter, routes, middleware
 * - EventRouter: Service-based event handler registration (mirrors ConnectRouter)
 * - MemoryAdapter: In-memory adapter for testing without external broker
 * - Middleware: Built-in retry and DLQ, extensible pipeline
 *
 * @module @connectum/events
 * @mergeModuleWith <project>
 */

// EventBus factory
export { createEventBus, deriveServiceName } from "./EventBus.ts";

// EventContext
export { createEventContext } from "./EventContext.ts";

// EventRouter
export { EventRouterImpl } from "./EventRouter.ts";

// Error classes
export { NonRetryableError, RetryableError } from "./errors.ts";

// Adapters
export { MemoryAdapter } from "./MemoryAdapter.ts";
export { dlqMiddleware } from "./middleware/dlq.ts";
export { retryMiddleware } from "./middleware/retry.ts";
// Middleware
export { composeMiddleware } from "./middleware.ts";

// Topic resolution
export { resolveTopicName } from "./topic.ts";
// Types
export type {
    AdapterContext,
    DlqOptions,
    EventAdapter,
    EventBus,
    EventBusOptions,
    EventContext,
    EventContextInit,
    EventHandlerConfig,
    EventMiddleware,
    EventMiddlewareNext,
    EventRoute,
    EventRouteEntry,
    EventRouter,
    EventSubscription,
    MiddlewareConfig,
    PublishOptions,
    RawEvent,
    RawEventHandler,
    RawSubscribeOptions,
    RetryOptions,
    ServiceEventHandlers,
    TypedEventHandler,
} from "./types.ts";
// Wildcard matching
export { matchPattern } from "./wildcard.ts";

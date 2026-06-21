# @connectum/events

Universal event adapter layer for Connectum: proto-first pub/sub with pluggable broker adapters.

**@connectum/events** provides a transport-agnostic EventBus for publishing and subscribing to events using protobuf schemas. Swap between NATS, Kafka, Redis Streams, or in-memory adapter without changing application code.

**Layer**: 1 (Extension) | **Node.js**: >=22.13.0 | **License**: Apache-2.0

## Features

- **createEventBus()** -- factory with explicit lifecycle (`start()` / `stop()`)
- **createBroadcastSubscribers()** -- 1->N fan-out wiring: one event delivered to N independent reactors, each on its own bus + consumer group
- **Proto-first** -- publish and subscribe using `@bufbuild/protobuf` message schemas
- **Pluggable Adapters** -- swap NATS, Kafka, Redis Streams, or in-memory without code changes
- **EventRouter** -- type-safe handler registration mirroring ConnectRouter pattern
- **Middleware Pipeline** -- composable middleware with built-in retry and DLQ
- **Wildcard Subscriptions** -- NATS-style patterns (`*` single segment, `>` greedy)
- **MemoryAdapter** -- zero-dependency in-memory adapter for testing
- **Graceful Shutdown** -- integrates with `@connectum/core` via `EventBusLike` interface
- **Auto-ack** -- successful handler completion auto-acknowledges if neither `ack()` nor `nack()` called

## Installation

```bash
pnpm add @connectum/events
```

**Peer dependencies** (installed automatically):

```bash
pnpm add @bufbuild/protobuf
```

You also need a broker adapter:

```bash
pnpm add @connectum/events-nats    # NATS JetStream
pnpm add @connectum/events-kafka   # Kafka / Redpanda
pnpm add @connectum/events-redis   # Redis Streams
```

## Quick Start

### Minimal Example (in-memory)

```typescript
import { createEventBus, MemoryAdapter } from '@connectum/events';
import { UserCreatedSchema } from '#gen/events_pb.js';

const bus = createEventBus({
  adapter: MemoryAdapter(),
});

await bus.start();

// Publish an event
await bus.publish(UserCreatedSchema, { id: '1', name: 'Alice' });

await bus.stop();
```

### With Routes and Middleware

```typescript
import { createEventBus } from '@connectum/events';
import { NatsAdapter } from '@connectum/events-nats';
import { UserCreatedSchema } from '#gen/events_pb.js';
import { UserService } from '#gen/user_pb.js';

const bus = createEventBus({
  adapter: NatsAdapter({ servers: 'nats://localhost:4222' }),
  routes: [eventRoutes],
  middleware: {
    retry: { maxRetries: 3, backoff: 'exponential' },
    dlq: { topic: 'service.dlq' },
  },
});

await bus.start();
```

### Integration with @connectum/core

```typescript
import { createServer } from '@connectum/core';
import { createEventBus } from '@connectum/events';
import { NatsAdapter } from '@connectum/events-nats';

const eventBus = createEventBus({
  adapter: NatsAdapter({ servers: 'nats://localhost:4222' }),
  routes: [eventRoutes],
});

const server = createServer({
  services: [routes],
  port: 5000,
  eventBus, // Lifecycle managed by server
});

await server.start(); // Also starts eventBus
```

### EventRouter (type-safe handlers)

```typescript
import type { EventRouter } from '@connectum/events';
import { UserService } from '#gen/user_pb.js';
import { UserCreatedSchema } from '#gen/events_pb.js';

export default (router: EventRouter) => {
  router.service(UserService, {
    async userCreated(event, ctx) {
      // event is typed from the proto schema (first positional arg)
      console.log(`User created: ${event.name}`);
      // Auto-ack on successful return
    },
  });
};
```

## Middleware

The middleware pipeline wraps event handlers in the order:

```text
Custom[0] → Custom[1] → ... → DLQ → Retry → Handler
```

### Retry Middleware

Retries failed handlers with configurable backoff strategy.

```typescript
const bus = createEventBus({
  adapter: NatsAdapter({ servers: 'nats://localhost:4222' }),
  middleware: {
    retry: {
      maxRetries: 3,           // Max retry attempts (default: 3)
      backoff: 'exponential',  // 'exponential' | 'linear' | 'fixed'
      initialDelay: 200,       // Initial delay in ms (default: 1000)
      maxDelay: 30000,         // Max delay in ms (default: 30000)
      retryableErrors: (err) => !(err instanceof ValidationError),
    },
  },
});
```

### DLQ Middleware

Routes permanently failed events to a dead-letter queue topic.

```typescript
const bus = createEventBus({
  adapter: NatsAdapter({ servers: 'nats://localhost:4222' }),
  middleware: {
    dlq: {
      topic: 'service.dlq',        // DLQ topic name (required)
      errorSerializer: (err) => (err instanceof Error ? err.message : String(err)),
    },
  },
});
```

### Custom Middleware

```typescript
import type { EventMiddleware } from '@connectum/events';

const loggingMiddleware: EventMiddleware = async (event, ctx, next) => {
  console.log(`Processing event: ${ctx.eventType}`);
  const start = Date.now();
  await next();
  console.log(`Processed in ${Date.now() - start}ms`);
};

const bus = createEventBus({
  adapter: NatsAdapter({ servers: 'nats://localhost:4222' }),
  middleware: {
    custom: [loggingMiddleware],
    retry: { maxRetries: 3 },
    dlq: { topic: 'service.dlq' },
  },
});
```

### Typed Errors

Control retry behavior declaratively by throwing typed error classes:

```typescript
import { NonRetryableError, RetryableError } from '@connectum/events';

// Skip retry entirely (e.g., validation errors)
throw new NonRetryableError('Invalid payload schema');

// Force retry regardless of retryableErrors predicate
throw new RetryableError('Temporary connection lost', { cause: originalError });
```

**Priority**: `NonRetryableError` > `RetryableError` > `retryableErrors` predicate > retry all (default).

Both classes use `Symbol.for()` branding for cross-realm compatibility.

## API Reference

### createEventBus()

```typescript
import { createEventBus } from '@connectum/events';

function createEventBus(options: EventBusOptions): EventBus
```

**Parameters (`EventBusOptions`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `adapter` | `EventAdapter` | required | Broker adapter (NATS, Kafka, Redis, Memory) |
| `routes` | `EventRoute[]` | `[]` | Event route handlers (subscriber side) |
| `publishes` | `DescService[]` | `[]` | Event service descriptors this process publishes to (publisher side, no subscription) |
| `strictTopics` | `boolean` | `false` | Throw on an unresolved publish topic instead of silently falling back to the message `typeName` |
| `middleware` | `MiddlewareConfig` | `{}` | Middleware configuration |
| `group` | `string` | `undefined` | Consumer group name |
| `signal` | `AbortSignal` | `undefined` | External abort signal |
| `handlerTimeout` | `number` | `30000` | Per-handler timeout in ms |
| `drainTimeout` | `number` | `30000` | Max ms to wait for in-flight handlers during shutdown |

> **Publisher-only processes:** when a service publishes an event but does not subscribe to it (the usual split-microservices shape), it has no `routes`, so `publish()` would fall back to the message `typeName` — silently emitting to the wrong topic whenever the event declares a custom `(connectum.events.v1.event).topic`. List the event service descriptors in `publishes` so the declared topic is resolved from the proto option end-to-end, instead of hand-maintaining raw topic strings:
>
> ```typescript
> import { OrderEventService } from '#gen/order/v1/order_pb.js';
>
> const bus = createEventBus({ adapter, publishes: [OrderEventService] });
> await bus.start();
> await bus.publish(OrderPlacedSchema, order); // → declared topic, not "order.v1.OrderPlaced"
> ```

> **`strictTopics` (opt-in, default `false`):** the same silent fallback also happens for any event covered by neither `routes` nor `publishes` and published without an explicit `PublishOptions.topic` — `publish()` emits to the raw `schema.typeName`. Set `strictTopics: true` to make that unresolved-topic case **throw** at the call site instead of silently misconfiguring. Backward-compatible; available since 1.1.0.

### createBroadcastSubscribers()

```typescript
import { createBroadcastSubscribers } from '@connectum/events';

function createBroadcastSubscribers(
  options: BroadcastSubscribersOptions,
): Array<EventBus & EventBusLike>
```

Available since 1.1.0.

First-class 1->N fan-out wiring. Delivering ONE published event to N **independent** reactors (each reacting on its own) requires one `EventBus` **per reactor**, each with its own consumer group:

- the per-bus duplicate-topic guard rejects two routes resolving to the same topic on one bus (it throws `Duplicate event topic "..." on one EventBus`), and
- on a real broker, a **shared** group load-balances (one reactor "steals" each event) while **distinct** groups give each reactor its own durable consumer.

`createBroadcastSubscribers()` builds that one-bus-per-reactor wiring from a list of reactors, so callers do not hand-roll N `createEventBus` calls. It **throws** if two reactors share a consumer group.

The returned buses are **not started** -- start (and later stop) them yourself.

```typescript
import { createBroadcastSubscribers } from '@connectum/events';
import { NatsAdapter } from '@connectum/events-nats';

// Per-bus adapter factory: each reactor bus gets its own connection / durable consumer
const buses = createBroadcastSubscribers({
  adapter: () => NatsAdapter({ servers: 'nats://localhost:4222' }),
  reactors: [
    { group: 'pricing', routes: [pricingRoutes] },
    { group: 'audit', routes: [auditRoutes] },
    { group: 'notify', routes: [notifyRoutes] },
  ],
});

await Promise.all(buses.map((bus) => bus.start()));

// On shutdown:
await Promise.all(buses.map((bus) => bus.stop()));
```

For in-process tests, pass a single shared `MemoryAdapter()` instance instead of a factory (all buses share the in-memory registry):

```typescript
import { createBroadcastSubscribers, MemoryAdapter } from '@connectum/events';

const buses = createBroadcastSubscribers({
  adapter: MemoryAdapter(), // one shared instance
  reactors: [
    { group: 'pricing', routes: [pricingRoutes] },
    { group: 'audit', routes: [auditRoutes] },
  ],
});

await Promise.all(buses.map((bus) => bus.start()));
```

**Parameters (`BroadcastSubscribersOptions`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `adapter` | `EventAdapter \| (() => EventAdapter)` | required | One shared adapter instance (fine for `MemoryAdapter` in tests) OR a factory invoked once per reactor (use for real brokers so each bus gets its own connection / durable consumer) |
| `reactors` | `BroadcastReactor[]` | required | The independent reactors -- each becomes its own EventBus with its own group |
| `handlerTimeout` | `number` | `30000` | Shared per-bus handler timeout in ms |
| `drainTimeout` | `number` | `30000` | Shared per-bus drain timeout in ms |
| `signal` | `AbortSignal` | `undefined` | Shared abort signal for graceful shutdown |

**`BroadcastReactor`:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `group` | `string` | required | Consumer group -- MUST be distinct per reactor for true fan-out (a shared group load-balances) |
| `routes` | `EventRoute[]` | required | The event routes (handlers) this reactor subscribes with |
| `middleware` | `MiddlewareConfig` | `undefined` | Optional per-reactor middleware (retry / DLQ / custom) |

### EventBus Interface

```typescript
interface EventBus {
  // A passed signal overrides the construction-time EventBusOptions.signal
  start(options?: { signal?: AbortSignal }): Promise<void>;
  stop(): Promise<void>;
  publish<Desc extends DescMessage>(schema: Desc, data: MessageShape<Desc>, options?: PublishOptions): Promise<void>;
}
```

### PublishOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metadata` | `Record<string, string>` | `undefined` | Event metadata / headers |
| `topic` | `string` | `undefined` | Override the schema-derived event type / topic name |
| `group` | `string` | `undefined` | Named group tag for workflow grouping |
| `key` | `string` | `undefined` | Partition key (Kafka) or routing key |

### EventContext

| Property | Type | Description |
|----------|------|-------------|
| `eventType` | `string` | Event type / topic name |
| `eventId` | `string` | Unique event identifier |
| `publishedAt` | `Date` | When the event was published |
| `attempt` | `number` | Delivery attempt number (1-based) |
| `metadata` | `ReadonlyMap<string, string>` | Event metadata |
| `signal` | `AbortSignal` | Abort signal (shutdown + timeout) |
| `ack()` | `() => Promise<void>` | Acknowledge event (idempotent) |
| `nack(requeue?)` | `(requeue?: boolean) => Promise<void>` | Negative-acknowledge event |

### DlqOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | `string` | required | DLQ topic name |
| `errorSerializer` | `(error: unknown) => string` | `error.name` only | Custom error serialization |

### RetryOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum retry attempts |
| `backoff` | `'exponential' \| 'linear' \| 'fixed'` | `'exponential'` | Backoff strategy |
| `initialDelay` | `number` | `1000` | Initial delay in ms |
| `maxDelay` | `number` | `30000` | Maximum delay in ms |
| `multiplier` | `number` | `2` | Multiplier for exponential backoff |
| `retryableErrors` | `(err: unknown) => boolean` | All errors | Filter for retryable errors |

## MemoryAdapter

Zero-dependency in-memory adapter for unit and integration tests.

```typescript
import { createEventBus, MemoryAdapter } from '@connectum/events';

const bus = createEventBus({
  adapter: MemoryAdapter(),
  routes: [myRoutes],
});

await bus.start();

// Publish and consume synchronously in-process
await bus.publish(MyEventSchema, { value: 42 });

await bus.stop();
```

Supports wildcard subscriptions (`*` and `>` patterns).

## Graceful Shutdown

EventBus tracks in-flight message handlers and waits for them to complete during `stop()`:

```typescript
const bus = createEventBus({
  adapter: NatsAdapter({ servers: 'nats://localhost:4222' }),
  routes: [eventRoutes],
  drainTimeout: 15_000, // Wait up to 15s for handlers (default: 30s)
});

// During stop():
// 1. Stop accepting new messages (nack with requeue)
// 2. Wait for in-flight handlers up to drainTimeout
// 3. Force-abort remaining via AbortSignal
// 4. Disconnect adapter
await bus.stop();
```

Set `drainTimeout: 0` for immediate abort (skip drain).

## Exports Summary

| Export | Kind | Description |
|--------|------|-------------|
| `createEventBus` | function | Factory for creating an EventBus |
| `createBroadcastSubscribers` | function | Builds one-bus-per-reactor 1->N fan-out wiring from a list of reactors |
| `deriveServiceName` | function | Derives a consumer identity (`package@hostname`) from proto service names |
| `NonRetryableError` | class | Error that skips retry middleware |
| `RetryableError` | class | Error that forces retry |
| `EventRouterImpl` | class | Event router implementation |
| `MemoryAdapter` | function | In-memory adapter factory |
| `dlqMiddleware` | function | DLQ middleware factory |
| `retryMiddleware` | function | Retry middleware factory |
| `composeMiddleware` | function | Middleware composition utility |
| `createEventContext` | function | EventContext factory |
| `resolveTopicName` | function | Topic name resolution from proto |
| `matchPattern` | function | NATS-style wildcard matching |
| `EventAdapter` | type | Adapter interface |
| `EventBus` | type | EventBus interface |
| `EventBusOptions` | type | Options for `createEventBus()` |
| `BroadcastSubscribersOptions` | type | Options for `createBroadcastSubscribers()` |
| `BroadcastReactor` | type | One independent broadcast reactor (group + routes + optional middleware) |
| `EventContext` | type | Handler context interface |
| `EventRouter` | type | Router interface |
| `PublishOptions` | type | Publish options |
| `EventMiddleware` | type | Middleware function type |
| `RetryOptions` | type | Retry middleware options |
| `DlqOptions` | type | DLQ middleware options |
| `RawEvent` | type | Raw event from adapter |
| `RawEventHandler` | type | Raw event handler type |
| `EventSubscription` | type | Subscription handle |
| `MiddlewareConfig` | type | Middleware configuration |

For the complete, always-current list of exported symbols and types, see the [API Reference](https://connectum.dev/en/api/).

## Dependencies

### Internal

- `@connectum/core` -- `EventBusLike` interface for server integration

### External

- `@bufbuild/protobuf` -- Protocol Buffers runtime (serialization/deserialization)

## Requirements

- **Node.js**: >=22.13.0
- **pnpm**: >=10.0.0
- **TypeScript**: >=5.7.2 (for type checking)

## Documentation

- [EventBus Guide](https://connectum.dev/en/guide/events)
- [Getting Started](https://connectum.dev/en/guide/events/getting-started)
- [Middleware](https://connectum.dev/en/guide/events/middleware)
- [Adapters](https://connectum.dev/en/guide/events/adapters)
- [ADR-026: EventBus Architecture](https://connectum.dev/en/contributing/adr/026-eventbus-architecture)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

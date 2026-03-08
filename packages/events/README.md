# @connectum/events

Universal event adapter layer for Connectum: proto-first pub/sub with pluggable broker adapters.

**@connectum/events** provides a transport-agnostic EventBus for publishing and subscribing to events using protobuf schemas. Swap between NATS, Kafka, Redis Streams, or in-memory adapter without changing application code.

**Layer**: 1 (Extension) | **Node.js**: >=18.0.0 | **License**: Apache-2.0

## Features

- **createEventBus()** -- factory with explicit lifecycle (`start()` / `stop()`)
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
    async userCreated(ctx) {
      const event = ctx.event; // Typed from proto schema
      console.log(`User created: ${event.name}`);
      // Auto-ack on successful return
    },
  });
};
```

## Middleware

The middleware pipeline wraps event handlers in the order:

```
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
      initialDelay: 200,       // Initial delay in ms (default: 200)
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
      errorSerializer: (err) => ({  // Custom error serialization
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    },
  },
});
```

### Custom Middleware

```typescript
import type { EventMiddleware } from '@connectum/events';

const loggingMiddleware: EventMiddleware = (next) => async (ctx) => {
  console.log(`Processing event: ${ctx.eventType}`);
  const start = Date.now();
  await next(ctx);
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
| `routes` | `EventRoute[]` | `[]` | Event route handlers |
| `middleware` | `MiddlewareConfig` | `{}` | Middleware configuration |
| `group` | `string` | `undefined` | Consumer group name |
| `signal` | `AbortSignal` | `undefined` | External abort signal |
| `handlerTimeout` | `number` | `undefined` | Per-handler timeout in ms |

### EventBus Interface

```typescript
interface EventBus {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish<T>(schema: DescMessage, data: T, options?: PublishOptions): Promise<void>;
}
```

### PublishOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metadata` | `Record<string, string>` | `undefined` | Event metadata / headers |
| `key` | `string` | `undefined` | Partition key (Kafka) or routing key |

### EventContext

| Property | Type | Description |
|----------|------|-------------|
| `event` | `T` | Deserialized event payload |
| `eventType` | `string` | Event type / topic name |
| `eventId` | `string` | Unique event identifier |
| `metadata` | `Map<string, string>` | Event metadata |
| `signal` | `AbortSignal` | Abort signal (shutdown + timeout) |
| `ack()` | `() => void` | Acknowledge event (idempotent) |
| `nack(requeue?)` | `(requeue?: boolean) => void` | Negative-acknowledge event |

### DlqOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | `string` | required | DLQ topic name |
| `errorSerializer` | `(error: unknown) => Record<string, unknown>` | Default serializer | Custom error serialization |

### RetryOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum retry attempts |
| `backoff` | `'exponential' \| 'linear' \| 'fixed'` | `'exponential'` | Backoff strategy |
| `initialDelay` | `number` | `200` | Initial delay in ms |
| `maxDelay` | `number` | `30000` | Maximum delay in ms |
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

## Exports Summary

| Export | Kind | Description |
|--------|------|-------------|
| `createEventBus` | function | Factory for creating an EventBus |
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

## Dependencies

### Internal

- `@connectum/core` -- `EventBusLike` interface for server integration

### External

- `@bufbuild/protobuf` -- Protocol Buffers runtime (serialization/deserialization)

## Requirements

- **Node.js**: >=18.0.0
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

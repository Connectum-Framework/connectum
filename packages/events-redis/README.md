# @connectum/events-redis

Redis Streams adapter for `@connectum/events`.

**@connectum/events-redis** connects the Connectum EventBus to [Redis Streams](https://redis.io/docs/data-types/streams/) via [ioredis](https://github.com/redis/ioredis) for lightweight, low-latency event streaming with consumer group support.

**Layer**: 2 (Tools) | **Node.js**: >=20.0.0 | **License**: Apache-2.0

## Features

- **Redis Streams** -- durable, append-only log with consumer group load balancing
- **Consumer Groups** -- automatic XREADGROUP with configurable block timeout
- **Stale Message Reclamation** -- XAUTOCLAIM reclaims idle pending entries
- **Stream Trimming** -- optional MAXLEN trimming on publish
- **Connection Isolation** -- dedicated blocking reader per subscription
- **Metadata as Fields** -- event metadata stored as `meta:*` stream fields

## Installation

```bash
pnpm add @connectum/events-redis
```

**Peer dependencies:**

```bash
pnpm add @connectum/events
```

## Quick Start

```typescript
import { createEventBus } from '@connectum/events';
import { RedisAdapter } from '@connectum/events-redis';

const bus = createEventBus({
  adapter: RedisAdapter({
    url: 'redis://localhost:6379',
  }),
  routes: [eventRoutes],
  group: 'my-service',
});

await bus.start();
```

### With Full Options

```typescript
const bus = createEventBus({
  adapter: RedisAdapter({
    url: 'redis://localhost:6379',
    redisOptions: {
      password: process.env.REDIS_PASSWORD,
      tls: {},
      db: 1,
    },
    brokerOptions: {
      maxLen: 100000,   // Trim streams to 100k entries
      blockMs: 10000,   // Block 10s per XREADGROUP call
      count: 50,        // Read 50 messages per batch
    },
  }),
  routes: [eventRoutes],
  group: 'worker-pool',
  middleware: {
    retry: { maxRetries: 3 },
    dlq: { topic: 'service.dlq' },
  },
});
```

## API Reference

### RedisAdapter()

```typescript
import { RedisAdapter } from '@connectum/events-redis';

function RedisAdapter(options: RedisAdapterOptions): EventAdapter
```

### RedisAdapterOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | `undefined` | Redis connection URL (e.g., `redis://localhost:6379`) |
| `redisOptions` | `RedisOptions` | `undefined` | ioredis connection options (merged with URL if both set) |
| `brokerOptions` | `RedisBrokerOptions` | `{}` | Stream consumption tuning |

### RedisBrokerOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxLen` | `number` | `undefined` | Max stream length (XADD MAXLEN trimming) |
| `blockMs` | `number` | `5000` | XREADGROUP block timeout in ms |
| `count` | `number` | `10` | Messages per XREADGROUP call |

## How It Works

### Stream Key Mapping

Event types are mapped to Redis stream keys with the `events:` prefix:

```text
EventType: "user.created"
Stream:    "events:user.created"
```

### Consumer Groups

Subscriptions use Redis consumer groups (XREADGROUP) for load balancing across multiple instances. Each instance creates a unique consumer name within the group.

### Stale Message Reclamation

The adapter periodically calls XAUTOCLAIM (every 5 iterations) to reclaim messages that have been pending for more than 30 seconds, ensuring no messages are lost if a consumer crashes.

### Connection Isolation

Each subscription creates a dedicated Redis connection for blocking XREADGROUP calls, preventing blocking operations from interfering with publish or other subscriptions.

### Metadata

Event metadata is stored as stream fields with the `meta:` prefix:

```text
Stream entry fields:
  payload   → serialized event data
  meta:user → "alice"
  meta:env  → "production"
```

## Dependencies

### External

- `ioredis` -- Redis client for Node.js

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=20.0.0
- **Redis**: >=6.2 (for XAUTOCLAIM support)

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

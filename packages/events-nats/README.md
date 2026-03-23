# @connectum/events-nats

NATS JetStream adapter for `@connectum/events`.

**@connectum/events-nats** connects the Connectum EventBus to [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for durable, at-least-once event delivery with automatic stream management.

**Layer**: 2 (Tools) | **Node.js**: >=20.0.0 | **License**: Apache-2.0

## Features

- **JetStream Integration** -- durable, at-least-once delivery via NATS JetStream
- **Auto-Stream Creation** -- creates JetStream stream on connect if not exists
- **Durable Consumers** -- deterministic consumer naming for load balancing
- **Wildcard Subscriptions** -- native NATS wildcard patterns (`*`, `>`)
- **Metadata as Headers** -- event metadata mapped to NATS message headers
- **Configurable Delivery** -- ack wait, max delivery attempts, deliver policy

## Installation

```bash
pnpm add @connectum/events-nats
```

**Peer dependencies:**

```bash
pnpm add @connectum/events
```

## Quick Start

```typescript
import { createEventBus } from '@connectum/events';
import { NatsAdapter } from '@connectum/events-nats';

const bus = createEventBus({
  adapter: NatsAdapter({
    servers: 'nats://localhost:4222',
  }),
  routes: [eventRoutes],
});

await bus.start();
```

### With Full Options

```typescript
const bus = createEventBus({
  adapter: NatsAdapter({
    servers: ['nats://node1:4222', 'nats://node2:4222'],
    stream: 'my-service',
    consumerOptions: {
      deliverPolicy: 'all',
      ackWait: 60000,
      maxDeliver: 10,
    },
  }),
  routes: [eventRoutes],
  group: 'worker-group',
  middleware: {
    retry: { maxRetries: 3 },
    dlq: { topic: 'service.dlq' },
  },
});
```

## API Reference

### NatsAdapter()

```typescript
import { NatsAdapter } from '@connectum/events-nats';

function NatsAdapter(options: NatsAdapterOptions): EventAdapter
```

### NatsAdapterOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `servers` | `string \| string[]` | required | NATS server URL(s) |
| `stream` | `string` | `'events'` | JetStream stream name |
| `connectionOptions` | `Partial<NodeConnectionOptions>` | `undefined` | Advanced NATS connection options |
| `consumerOptions` | `NatsConsumerOptions` | `{}` | Consumer tuning |

### NatsConsumerOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `deliverPolicy` | `'new' \| 'all' \| 'last'` | `'new'` | Message delivery policy |
| `ackWait` | `number` | `30000` | Ack timeout in ms |
| `maxDeliver` | `number` | `5` | Max delivery attempts before giving up |

## How It Works

### Topic Mapping

Event types are mapped to NATS subjects with the stream name prefix:

```text
EventType: "user.created"
Stream:    "events"
Subject:   "events.user.created"
```

### Consumer Naming

Durable consumers use deterministic names to ensure load balancing across instances. Group and pattern are sanitized (invalid durable-name characters replaced with `_`):

```text
Format:  {sanitized-group}--{sanitized-pattern}--{hash}
Example: worker-group--user_created--a1b2c3d4
```

### Metadata

Event metadata is transmitted as NATS message headers. Internal headers (prefixed with `x-`) are stripped when parsing.

## Dependencies

### External

- `@nats-io/jetstream` -- NATS JetStream client
- `@nats-io/transport-node` -- NATS Node.js transport

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=20.0.0
- **NATS Server**: >=2.9 with JetStream enabled

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

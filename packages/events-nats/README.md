# @connectum/events-nats

NATS JetStream adapter for `@connectum/events`.

**@connectum/events-nats** connects the Connectum EventBus to [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for durable, at-least-once event delivery with automatic stream management.

**Layer**: 2 (Tools) | **Node.js**: >=22.13.0 | **License**: Apache-2.0

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

### Overlapping Patterns

A JetStream consumer delivers a stream message once, and every pattern of a subscription gets its own consumer. When several patterns of one subscription match the same subject (`user.created`, `user.*` and `user.>` all match `user.created`), one event per consumer would reach the handler. The adapter therefore creates consumers for the patterns that remain after dropping every pattern another one contains: the three patterns above share the single consumer of `user.>`, and the event is delivered once. Patterns that overlap with nothing keep their own consumer and name, exactly as before.

Two patterns that overlap only in part (`a.*.c` and `a.b.*` both match `a.b.c`) cannot be reduced that way. They are replaced by the narrowest single pattern that covers both (`a.>`), and the adapter acknowledges and skips any event that matches none of the patterns you asked for. NATS servers differ in whether one consumer may carry overlapping filters (2.10 rejects them), which is why the adapter does not rely on multi-filter consumers.

**Upgrading from a version that created one consumer per pattern:** consumers of dropped patterns are no longer used, but the adapter does not delete them, because other instances of the group may still run the old version. Backlog is not lost: the consumer that is kept was one of the old ones, so it resumes from its position and receives everything the dropped ones would have. After every instance runs the new version, list the consumers (`nats consumer ls <stream>`), find the ones named `{group}--{pattern}--{hash}` for the dropped patterns, and remove them (`nats consumer rm <stream> <name>`). Until then their pending count grows with every event, and on a stream with `interest` retention they keep every message in the stream, because they never acknowledge it.

### Metadata

Event metadata is transmitted as NATS message headers. Internal headers (prefixed with `x-`) are stripped when parsing.

## Dependencies

### External

- `@nats-io/jetstream` -- NATS JetStream client
- `@nats-io/transport-node` -- NATS Node.js transport

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=22.13.0
- **NATS Server**: >=2.9 with JetStream enabled

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** — Universal framework for production-ready gRPC/ConnectRPC microservices

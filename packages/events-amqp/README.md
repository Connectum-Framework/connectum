# @connectum/events-amqp

AMQP/RabbitMQ adapter for `@connectum/events`.

**@connectum/events-amqp** connects the Connectum EventBus to [RabbitMQ](https://www.rabbitmq.com/) (AMQP 0-9-1) for durable, at-least-once event delivery with topic exchanges, consumer groups, and dead-letter support.

**Layer**: 2 (Tools) | **Node.js**: >=18.0.0 | **License**: Apache-2.0

## Features

- **Topic Exchange** -- flexible routing via AMQP topic exchange with wildcard patterns
- **Consumer Groups** -- load-balanced consumption via named queues (competing consumers)
- **Publisher Confirms** -- optional synchronous publishing with broker acknowledgement
- **Dead Letter Exchange** -- built-in DLX support for rejected messages
- **Metadata as Headers** -- event metadata mapped to AMQP message headers
- **Prefetch Control** -- configurable QoS prefetch count per consumer

## Installation

```bash
pnpm add @connectum/events-amqp
```

**Peer dependencies:**

```bash
pnpm add @connectum/events
```

## Quick Start

```typescript
import { createEventBus } from '@connectum/events';
import { AmqpAdapter } from '@connectum/events-amqp';

const bus = createEventBus({
  adapter: AmqpAdapter({
    url: 'amqp://guest:guest@localhost:5672',
  }),
  routes: [eventRoutes],
});

await bus.start();
```

### With Full Options

```typescript
const bus = createEventBus({
  adapter: AmqpAdapter({
    url: 'amqp://guest:guest@localhost:5672',
    exchange: 'my-service.events',
    exchangeType: 'topic',
    exchangeOptions: {
      durable: true,
      autoDelete: false,
    },
    queueOptions: {
      durable: true,
      messageTtl: 60000,
      maxLength: 100000,
      deadLetterExchange: 'dlx.events',
      deadLetterRoutingKey: 'dlq',
    },
    consumerOptions: {
      prefetch: 20,
    },
    publisherOptions: {
      persistent: true,
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

### AmqpAdapter()

```typescript
import { AmqpAdapter } from '@connectum/events-amqp';

function AmqpAdapter(options: AmqpAdapterOptions): EventAdapter
```

### AmqpAdapterOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | required | AMQP connection URL |
| `socketOptions` | `Record<string, unknown>` | `undefined` | Socket options for connection |
| `exchange` | `string` | `'connectum.events'` | Exchange name |
| `exchangeType` | `'topic' \| 'direct' \| 'fanout' \| 'headers'` | `'topic'` | Exchange type |
| `exchangeOptions` | `AmqpExchangeOptions` | `{}` | Exchange assertion options |
| `queueOptions` | `AmqpQueueOptions` | `{}` | Queue assertion options |
| `consumerOptions` | `AmqpConsumerOptions` | `{}` | Consumer options |
| `publisherOptions` | `AmqpPublisherOptions` | `{}` | Publisher options |

### AmqpExchangeOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `durable` | `boolean` | `true` | Survive broker restarts |
| `autoDelete` | `boolean` | `false` | Delete when last queue unbinds |

### AmqpQueueOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `durable` | `boolean` | `true` | Survive broker restarts |
| `messageTtl` | `number` | `undefined` | Per-message TTL in ms |
| `maxLength` | `number` | `undefined` | Max messages in queue |
| `deadLetterExchange` | `string` | `undefined` | DLX exchange name |
| `deadLetterRoutingKey` | `string` | `undefined` | DLX routing key |

### AmqpConsumerOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prefetch` | `number` | `10` | QoS prefetch count |
| `exclusive` | `boolean` | `false` | Exclusive consumer |

### AmqpPublisherOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `persistent` | `boolean` | `true` | Persist messages (deliveryMode=2) |
| `mandatory` | `boolean` | `false` | Return unroutable messages |

## How It Works

### Topic Mapping

Event types are mapped to AMQP routing keys on the configured exchange:

```text
EventType:    "user.created"
Exchange:     "connectum.events"
Routing Key:  "user.created"
```

### Wildcard Conversion

EventBus wildcard patterns are converted to AMQP topic patterns:

```text
EventBus  →  AMQP
*         →  *     (single token -- same in both)
>         →  #     (multi-token greedy match)

Example: "order.>"  →  "order.#"
```

### Consumer Groups

| Mode | Queue Name | Behavior |
|------|-----------|----------|
| With `group` | `{exchange}.{group}` | Shared, durable, competing consumers |
| Without `group` | `{exchange}.sub-{uuid}` | Exclusive, auto-delete (fan-out) |

### Metadata

Event metadata is transmitted as AMQP message headers. Internal headers (`x-event-id`, `x-published-at`) are set on publish and stripped from metadata on delivery.

### Publisher Confirms

When `publishOptions.sync: true`, the adapter uses `ConfirmChannel.waitForConfirms()` to wait for broker acknowledgement before returning.

## Dependencies

### External

- `amqplib` -- AMQP 0-9-1 client for Node.js

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=18.0.0
- **RabbitMQ**: >=3.8

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

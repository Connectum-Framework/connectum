# @connectum/events-kafka

Kafka/Redpanda adapter for `@connectum/events`.

**@connectum/events-kafka** connects the Connectum EventBus to [Apache Kafka](https://kafka.apache.org/) or [Redpanda](https://redpanda.com/) via [KafkaJS](https://kafka.js.org/) for high-throughput, partitioned event streaming.

**Layer**: 2 (Tools) | **Node.js**: >=20.0.0 | **License**: Apache-2.0

## Features

- **KafkaJS Integration** -- production-ready Kafka client with automatic reconnection
- **Partition Key Support** -- message ordering via `PublishOptions.key`
- **Compression** -- configurable producer compression (gzip, snappy, lz4, zstd)
- **Wildcard Subscriptions** -- NATS-style patterns converted to Kafka regex subscriptions
- **Batch Processing** -- `eachBatch` consumption for high throughput
- **Redpanda Compatible** -- works with Redpanda out of the box

## Installation

```bash
pnpm add @connectum/events-kafka
```

**Peer dependencies:**

```bash
pnpm add @connectum/events
```

## Quick Start

```typescript
import { createEventBus } from '@connectum/events';
import { KafkaAdapter } from '@connectum/events-kafka';

const bus = createEventBus({
  adapter: KafkaAdapter({
    brokers: ['localhost:9092'],
  }),
  routes: [eventRoutes],
  group: 'my-service',
});

await bus.start();
```

### With Full Options

```typescript
import { CompressionTypes } from 'kafkajs';

const bus = createEventBus({
  adapter: KafkaAdapter({
    brokers: ['broker1:9092', 'broker2:9092'],
    clientId: 'order-service',
    kafkaConfig: {
      ssl: true,
      sasl: {
        mechanism: 'plain',
        username: process.env.KAFKA_USER!,
        password: process.env.KAFKA_PASS!,
      },
    },
    producerOptions: {
      compression: CompressionTypes.GZIP,
    },
    consumerOptions: {
      sessionTimeout: 60000,
      fromBeginning: false,
      allowAutoTopicCreation: true,
    },
  }),
  routes: [eventRoutes],
  group: 'order-workers',
  middleware: {
    retry: { maxRetries: 3 },
    dlq: { topic: 'orders.dlq' },
  },
});
```

## API Reference

### KafkaAdapter()

```typescript
import { KafkaAdapter } from '@connectum/events-kafka';

function KafkaAdapter(options: KafkaAdapterOptions): EventAdapter
```

### KafkaAdapterOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `brokers` | `string[]` | required | Kafka broker addresses |
| `clientId` | `string` | `'connectum'` | Kafka client ID |
| `kafkaConfig` | `Omit<Partial<KafkaConfig>, 'brokers' \| 'clientId'>` | `undefined` | Advanced KafkaJS config (ssl, sasl, etc.) |
| `producerOptions` | `object` | `{}` | Producer configuration |
| `producerOptions.compression` | `CompressionTypes` | `undefined` | Message compression type |
| `consumerOptions` | `object` | `{}` | Consumer configuration |
| `consumerOptions.sessionTimeout` | `number` | `30000` | Consumer session timeout in ms |
| `consumerOptions.fromBeginning` | `boolean` | `false` | Start consuming from beginning |
| `consumerOptions.allowAutoTopicCreation` | `boolean` | `false` | Allow automatic topic creation |

## How It Works

### Topic Mapping

Event types map directly to Kafka topics:

```text
EventType: "user.created"
Topic:     "user.created"
```

### Wildcard Conversion

NATS-style wildcards are converted to Kafka regex patterns:

| NATS Pattern | Kafka Regex | Matches |
|-------------|-------------|---------|
| `user.*` | `/^user\.[^.]+$/` | `user.created`, `user.deleted` |
| `user.>` | `/^user\..+$/` | `user.created`, `user.profile.updated` |
| `user.created` | Literal topic | `user.created` only |

### Partition Key

Use `PublishOptions.key` for message ordering within a partition:

```typescript
await bus.publish(OrderCreatedSchema, order, {
  key: order.customerId, // All orders for same customer go to same partition
});
```

### Metadata

Event metadata is transmitted as Kafka message headers (Buffer-encoded).

## Dependencies

### External

- `kafkajs` -- Apache Kafka client for Node.js

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=20.0.0
- **Kafka**: >=2.0 (or Redpanda)

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

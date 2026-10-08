# @connectum/events-kafka

Kafka/Redpanda adapter for `@connectum/events`.

**@connectum/events-kafka** connects the Connectum EventBus to [Apache Kafka](https://kafka.apache.org/) or [Redpanda](https://redpanda.com/) via [KafkaJS](https://kafka.js.org/) for high-throughput, partitioned event streaming.

**Layer**: 2 (Tools) | **Node.js**: >=22.13.0 | **License**: Apache-2.0

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
| `consumerOptions.fromBeginning` | `boolean` | `false` | Where a consumer group with no committed offset starts: the beginning of the topic (`true`) or its end (`false`). A group that has committed offsets always resumes from them |
| `consumerOptions.allowAutoTopicCreation` | `boolean` | `false` | Allow automatic topic creation |
| `consumerOptions.redeliveryDelay` | `number` | `1000` | Milliseconds a partition is paused after a message was left unsettled, before it is delivered again. `0` redelivers immediately; the maximum is `2147483647` |
| `consumerOptions.topicDiscoveryInterval` | `number` | not set | Milliseconds between checks of a wildcard subscription for newly created matching topics (see [Wildcard Conversion](#wildcard-conversion)). Unset means the topic list is fixed when `subscribe()` runs. A positive number up to `2147483647` |

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
| `>` | `/^(?!__).+$/` | every topic except those starting with `__` |
| `*` | `/^(?!__)[^.]+$/` | every single-segment topic except those starting with `__` |

A pattern that **opens with a wildcard** does not match topics whose name starts with `__`. Kafka names its own topics that way (`__consumer_offsets`, `__transaction_state`); without the exclusion a catch-all `>` would feed the broker's binary bookkeeping records to your handler. A pattern that spells the prefix out (`__audit.>`) and a literal topic name (`__audit`) are unaffected, as are names with a single leading underscore (`_schemas`). Other system topics your platform keeps (for example a schema registry's `_schemas`) are ordinary topic names to the adapter: use a narrower pattern if you do not want them.

**Wildcards are expanded once, when `subscribe()` runs.** KafkaJS turns the regex into the list of topics that exist at that moment and the consumer group joins with that fixed list. A matching topic created later is not consumed by that subscription (a NATS consumer filter, by contrast, is evaluated by the server for every message). Either create the topics before the service starts, restart the service after creating them, or set `consumerOptions.topicDiscoveryInterval`:

```typescript
KafkaAdapter({
  brokers: ['localhost:9092'],
  consumerOptions: { topicDiscoveryInterval: 30_000 },
});
```

With it, every interval the adapter lists the broker's topics; when a matching topic has appeared it restarts the subscription's consumer to include it. The restart rebalances the consumer group (consumption pauses for a few seconds, and messages being handled at that moment are delivered again) and happens only when there is a new topic; an unchanged topic list costs one metadata request per wildcard subscription per interval. A discovered topic is read from its first message regardless of `fromBeginning`. Subscriptions made only of literal topic names are never checked.

### Partition Key

Use `PublishOptions.key` for message ordering within a partition:

```typescript
await bus.publish(OrderCreatedSchema, order, {
  key: order.customerId, // All orders for same customer go to same partition
});
```

### Acknowledgement and Redelivery

Delivery is at-least-once. Offsets are committed only by the handler's outcome, never by
the client library on a timer:

| Handler outcome | Offset | What happens next |
|-----------------|--------|-------------------|
| `ack()` (EventBus calls it after a successful handler) | committed | next message |
| `nack(false)` | committed | message is skipped; `nack(false)` itself publishes no DLQ copy |
| `nack(true)` or `nack()` | not committed | the message and the rest of the batch are delivered again, in order |
| handler throws while the message is still uncommitted | not committed | same as `nack(true)`; the error is logged with topic, partition and offset |
| handler throws after `ack()` or `nack(false)` committed the offset | committed | the message is not redelivered; the error is still logged with topic, partition and offset |
| adapter used directly, handler returns without settling | not committed | same as `nack(true)` |

Through the EventBus a handler that returns normally without settling is acknowledged
automatically, so call `nack(true)` when the message must be redelivered. The DLQ middleware
publishes a copy only when the handler throws; it then acknowledges the original, so a message
the DLQ middleware moved is not redelivered.

A Kafka offset means "everything before it is consumed", so settlement is ordered: the first
message that is not committed ends the batch and is the first one fetched again. The first
settlement of a message wins; an `ack()` called after the handler returned is ignored.

An unsettled message is delivered again after `redeliveryDelay` (default `1000` ms): the
adapter pauses the partition for that long. `redeliveryDelay: 0` redelivers immediately, and
a handler that fails permanently then retries in a tight loop and writes one log line per
attempt.

A message that fails on every delivery blocks its partition indefinitely: nothing behind it is delivered until the handler succeeds, `nack(false)` is called, or the DLQ middleware moves it. `redeliveryDelay` only paces the loop; it does not end it. On an otherwise idle consumer the observed gap is a whole fetch cycle (5 s in KafkaJS) even for smaller values.

Use the retry and DLQ middleware to bound a permanently failing message.

`attempt` is always `1`: Kafka does not count deliveries.

### Start Position

A consumer group that has no committed offset starts at the end of the topic
(`fromBeginning: false`, the default), so messages published before the group first
commits an offset are not delivered. Once the group has committed, messages published while
it is stopped are delivered on restart. Set `fromBeginning: true` to read a topic's history
with a new group.

### Metadata

Event metadata is transmitted as Kafka message headers (Buffer-encoded).

## Dependencies

### External

- `kafkajs` -- Apache Kafka client for Node.js

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=22.13.0
- **Kafka**: >=2.0 (or Redpanda)

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

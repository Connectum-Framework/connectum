# @connectum/events-kafka

This README describes the 1.3.x source; that release is not yet published to npm.

Kafka and Redpanda adapter for `@connectum/events`, using partitions and consumer groups.

## Install

```bash
pnpm add @connectum/events-kafka @connectum/events
```

The adapter requires Node.js `>=22.13.0` and has `@connectum/events` as a peer dependency. See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Set the broker connection variable, then start the bus:

```typescript
import { createEventBus } from '@connectum/events';
import { KafkaAdapter } from '@connectum/events-kafka';

const bus = createEventBus({
  adapter: KafkaAdapter({ brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',') }),
});

await bus.start();
await bus.stop();
```

A Kafka-compatible broker must be reachable. Delivery is at-least-once; handlers should be idempotent. A message that fails repeatedly can block later messages in its partition; see the [acknowledgement and redelivery guidance](https://connectum.dev/en/guide/events/adapters#kafka-ack-redelivery).

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-kafka)
- [Adapter guide](https://connectum.dev/en/guide/events/adapters#kafka-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-kafka/types/interfaces/KafkaAdapterOptions)

## License

Apache-2.0

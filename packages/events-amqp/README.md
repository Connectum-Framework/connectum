# @connectum/events-amqp

This README describes the 1.3.x source; that release is not yet published to npm.

AMQP/RabbitMQ adapter for `@connectum/events`. It maps EventBus topics to exchanges and queues and supports delivery settlement, publisher confirms, dead-letter routing, and connection recovery.

## Install

```bash
pnpm add @connectum/events-amqp @connectum/events
```

The adapter requires Node.js `>=22.13.0` and has `@connectum/events` as a peer dependency. See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Set `AMQP_URL` to a reachable RabbitMQ-compatible broker, then start the bus:

```typescript
import { createEventBus } from '@connectum/events';
import { AmqpAdapter } from '@connectum/events-amqp';

const bus = createEventBus({
  adapter: AmqpAdapter({ url: process.env.AMQP_URL! }),
});

await bus.start();
await bus.stop();
```

Delivery is at-least-once. Make handlers idempotent and acknowledge only after their side effects complete. See the [AMQP reliability guide](https://connectum.dev/en/guide/events/amqp-reliability) for recovery and settlement behavior.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-amqp)
- [Adapter selection](https://connectum.dev/en/guide/events/adapters#amqp--rabbitmq-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-amqp/types/interfaces/AmqpAdapterOptions)

## License

Apache-2.0

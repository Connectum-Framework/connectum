# @connectum/events-nats

This README describes the 1.3.x source; that release is not yet published to npm.

NATS JetStream adapter for `@connectum/events`, with durable consumers and subject-based routing.

## Install

```bash
pnpm add @connectum/events-nats @connectum/events
```

The adapter requires Node.js `>=22.13.0` and has `@connectum/events` as a peer dependency. See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Set the broker connection variable, then start the bus:

```typescript
import { createEventBus } from '@connectum/events';
import { NatsAdapter } from '@connectum/events-nats';

const bus = createEventBus({
  adapter: NatsAdapter({ servers: process.env.NATS_URL ?? 'nats://localhost:4222' }),
});

await bus.start();
await bus.stop();
```

A NATS server with JetStream enabled must be reachable. Delivery is at-least-once; make handlers idempotent and acknowledge after their side effects complete.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-nats)
- [Adapter guide](https://connectum.dev/en/guide/events/adapters#nats-jetstream-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-nats/types/interfaces/NatsAdapterOptions)

## License

Apache-2.0

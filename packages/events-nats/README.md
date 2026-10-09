# @connectum/events-nats

This README documents `@connectum/events-nats` 1.3 and later.

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

This snippet only connects to JetStream and creates or checks the stream; with no
routes, it does not start a consumer. For routed delivery, a JetStream-enabled
server and a matching stream subject are required. Unacknowledged messages can be
redelivered until `maxDeliver` is reached (default `5`); at that point JetStream
stops redelivering them and emits a max-deliver advisory. Messages remain in the
stream subject to its retention policy. Make handlers idempotent and complete
side effects before acknowledging. See the [NATS adapter guide](https://connectum.dev/en/guide/events/adapters#nats-jetstream-adapter).

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-nats)
- [Adapter guide](https://connectum.dev/en/guide/events/adapters#nats-jetstream-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-nats/types/interfaces/NatsAdapterOptions)

## License

Apache-2.0

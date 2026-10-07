# @connectum/events-redis

This README describes the 1.3.x source; that release is not yet published to npm.

Redis Streams and Valkey adapter for `@connectum/events`, using stream consumer groups.

## Install

```bash
pnpm add @connectum/events-redis @connectum/events
```

The adapter requires Node.js `>=22.13.0` and has `@connectum/events` as a peer dependency. See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Set the broker connection variable, then start the bus:

```typescript
import { createEventBus } from '@connectum/events';
import { RedisAdapter } from '@connectum/events-redis';

const bus = createEventBus({
  adapter: RedisAdapter({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }),
});

await bus.start();
await bus.stop();
```

A Redis-compatible server must be reachable. Delivery is at-least-once; pending entries can be delivered again. Configure persistence and retention in the broker for the durability your service requires.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-redis)
- [Adapter guide](https://connectum.dev/en/guide/events/adapters#redis-streams-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-redis/types/interfaces/RedisAdapterOptions)

## License

Apache-2.0

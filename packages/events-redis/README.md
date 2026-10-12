# @connectum/events-redis

This README documents `@connectum/events-redis` 1.3 and later.

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

This snippet only connects to Redis; with no routes, it does not start a
consumer. For routed delivery, a reachable Redis-compatible server is required.
Pending stream entries can be reclaimed and delivered again; configure Redis
persistence and stream retention for the durability your service requires. See
the [Redis adapter guide](https://connectum.dev/en/guide/events/adapters#redis-streams-adapter)
for retention and stream-mapping options.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-redis)
- [Adapter guide](https://connectum.dev/en/guide/events/adapters#redis-streams-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-redis/types/interfaces/RedisAdapterOptions)

## License

Apache-2.0

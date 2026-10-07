# @connectum/events

This README describes the 1.3.x source; that release is not yet published to npm.

Proto-first event publishing and subscription with middleware, a memory adapter,
and pluggable broker adapters.

## Install

```bash
pnpm add @connectum/events
```

The package requires Node.js `>=22.13.0`. Peer dependencies are
`@connectum/core`, `@bufbuild/protobuf` `^2.16.0`, and
`@connectrpc/connect` `^2.2.0`. Use a broker adapter for persistent delivery;
the memory adapter is for tests and local development. See
[peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies)
and [adapter selection](https://connectum.dev/en/guide/events/adapters).

## Start here

Prerequisite: start from the public
[`examples/with-events-dlq`](https://github.com/Connectum-Framework/examples/tree/main/with-events-dlq)
project. Run `pnpm install` and `pnpm buf:generate` to generate its
`InventoryReservedSchema`. Save the snippet as `src/publish-example.ts` and run
`node src/publish-example.ts` on Node.js `>=25.2.0`. This snippet uses memory
delivery, so it does not require the example's NATS broker. See the
[events getting started guide](https://connectum.dev/en/guide/events/getting-started)
to register handlers and choose a persistent adapter.

```typescript
import { createEventBus, MemoryAdapter } from '@connectum/events';
import { InventoryReservedSchema, OrderEventHandlers } from '#gen/orders/v1/orders_pb.ts';

const bus = createEventBus({
  adapter: MemoryAdapter(),
  routes: [(events) => events.service(OrderEventHandlers, {
    async onInventoryReserved(event) {
      console.log(`Reserved ${event.quantity} ${event.product} for ${event.orderId}`);
    },
  })],
});

await bus.start();
await bus.publish(InventoryReservedSchema, {
  orderId: 'order-1', product: 'book', quantity: 1,
});
await bus.stop();
```

## Constraints

- `MemoryAdapter` does not persist messages and does not provide consumer groups.
- Broker adapters provide at-least-once delivery. Handlers should be idempotent
  and acknowledge only after completing their side effects.
- Install the adapter for your broker separately: `@connectum/events-nats`,
  `@connectum/events-kafka`, `@connectum/events-redis`, or
  `@connectum/events-amqp`.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events)
- [Events guide](https://connectum.dev/en/guide/events)
- [Middleware guide](https://connectum.dev/en/guide/events/middleware)
- [API reference](https://connectum.dev/en/api/@connectum/events/)

## License

Apache-2.0

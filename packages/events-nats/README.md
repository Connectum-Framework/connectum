# @connectum/events-nats

NATS JetStream adapter for `@connectum/events`.

**@connectum/events-nats** connects the Connectum EventBus to [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for durable, at-least-once event delivery with automatic stream management.

**Layer**: 2 (Tools) | **Node.js**: >=22.13.0 | **License**: Apache-2.0

## Features

- **JetStream Integration** -- durable, at-least-once delivery via NATS JetStream
- **Auto-Stream Creation** -- creates JetStream stream on connect if not exists
- **Durable Consumers** -- deterministic consumer naming for load balancing
- **Wildcard Subscriptions** -- native NATS wildcard patterns (`*`, `>`)
- **Metadata as Headers** -- event metadata mapped to NATS message headers
- **Configurable Delivery** -- ack wait, max delivery attempts, deliver policy

## Installation

```bash
pnpm add @connectum/events-nats
```

**Peer dependencies:**

```bash
pnpm add @connectum/events
```

## Quick Start

```typescript
import { createEventBus } from '@connectum/events';
import { NatsAdapter } from '@connectum/events-nats';

const bus = createEventBus({
  adapter: NatsAdapter({
    servers: 'nats://localhost:4222',
  }),
  routes: [eventRoutes],
});

await bus.start();
```

### With Full Options

```typescript
const bus = createEventBus({
  adapter: NatsAdapter({
    servers: ['nats://node1:4222', 'nats://node2:4222'],
    stream: 'my-service',
    consumerOptions: {
      deliverPolicy: 'all',
      ackWait: 60000,
      maxDeliver: 10,
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

### NatsAdapter()

```typescript
import { NatsAdapter } from '@connectum/events-nats';

function NatsAdapter(options: NatsAdapterOptions): EventAdapter
```

### NatsAdapterOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `servers` | `string \| string[]` | required | NATS server URL(s) |
| `stream` | `string` | `'events'` | JetStream stream name |
| `connectionOptions` | `Partial<NodeConnectionOptions>` | `undefined` | Advanced NATS connection options |
| `consumerOptions` | `NatsConsumerOptions` | `{}` | Consumer tuning |

### NatsConsumerOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `deliverPolicy` | `'new' \| 'all' \| 'last'` | `'new'` | Message delivery policy |
| `ackWait` | `number` | `30000` | Ack timeout in ms |
| `maxDeliver` | `number` | `5` | Max delivery attempts before giving up |

## How It Works

### Topic Mapping

Event types are mapped to NATS subjects with the stream name prefix:

```text
EventType: "user.created"
Stream:    "events"
Subject:   "events.user.created"
```

### Consumer Naming

Durable consumers use deterministic names to ensure load balancing across instances. Group and pattern are sanitized (invalid durable-name characters replaced with `_`):

```text
Format:  {sanitized-group}--{sanitized-pattern}--{hash}
Example: worker-group--user_created--a1b2c3d4
```

### Overlapping Patterns

A JetStream consumer delivers a stream message once, and every pattern of a subscription keeps its own durable consumer (the layout above). When several patterns of one subscription match the same subject (`user.created`, `user.*` and `user.>` all match `user.created`), the adapter therefore receives the event once per matching consumer. It runs your handler for exactly one of those deliveries and acknowledges the others without running it.

The delivery that runs the handler is the one of the most specific pattern among those whose consumer delivers the event: fewer `>` first, then fewer `*`, then more tokens, then the pattern text. The order is derived from the pattern text alone, so every replica of a group chooses the same delivery, and partly overlapping patterns (`a.*.c` and `a.b.*` both match `a.b.c`) need no special case. A consumer delivers only events from the point where it began to exist, so an event that a more specific consumer could not have received (it was created later than the event) is handled by the delivery of the broader one.

- **Backlog of existing consumers.** Consumers left by earlier versions, or by earlier runs of the service, keep their position. Events that were published while the service was down are delivered once, whichever of the overlapping patterns holds them. A pattern added later starts at `consumerOptions.deliverPolicy` (`"new"` by default) like any new route.
- **Existing consumers are never modified.** The adapter reads an existing consumer and attaches to it; it does not update its configuration, so an earlier version of the adapter can create the same consumer again after a rollback, and consumers provisioned by an operator need only read and pull permissions (`$JS.API.CONSUMER.INFO.>`, `$JS.API.CONSUMER.MSG.NEXT.>`, `$JS.ACK.>`). Each replica works out from where every consumer delivers from what the server reports; nothing is written to the broker. When an existing consumer was configured with another `ackWait`, `maxDeliver` or `deliverPolicy` than the subscription asks for, the adapter keeps the existing one and logs one warning per consumer.
- **Replicas with different route sets.** While a service is rolled out with a route added to a broader pattern, replicas that have the route and replicas that do not run side by side. No event is lost; an event that the older replica's broader consumer takes can be handled by both kinds of replica, so a handler may see it twice. That is the at-least-once contract of the adapter, and the window lasts as long as the rollout. The same can happen on any server when replicas attach at different times while a wider consumer still lags behind a narrower one, and when the consumer of a pattern holds a delivery that was never acknowledged.
- **Network traffic.** Overlapping patterns still make the server send the event once per pattern, as before; only the handler runs once. Prefer non-overlapping patterns on a hot subject.
- **Consumers of removed routes.** Consumers of patterns you stopped subscribing to stay on the broker, as they always did, and their pending count grows with every matching event. Remove them with `nats consumer ls <stream>` and `nats consumer rm <stream> <name>` once no replica runs the old route set. Do not remove a consumer of a pattern that a running replica still subscribes: it stops delivering without an error. A `subscribe()` that fails half-way leaves the consumers of a named group in place for the next start; only the consumers of an auto-generated group are removed.

### Metadata

Event metadata is transmitted as NATS message headers. Internal headers (prefixed with `x-`) are stripped when parsing.

## Dependencies

### External

- `@nats-io/jetstream` -- NATS JetStream client
- `@nats-io/transport-node` -- NATS Node.js transport

### Peer

- `@connectum/events` -- EventBus core

## Requirements

- **Node.js**: >=22.13.0
- **NATS Server**: >=2.9 with JetStream enabled

## Documentation

- [Adapters Guide](https://connectum.dev/en/guide/events/adapters)
- [EventBus Guide](https://connectum.dev/en/guide/events)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** — Universal framework for production-ready gRPC/ConnectRPC microservices

# @connectum/events-amqp

This README documents `@connectum/events-amqp` 1.3 and later.

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

Delivery and retention depend on the broker topology and publish settings. In
the default `assert` mode, a subscription without a named consumer group uses a
private, non-durable, auto-delete queue; `check` and `skip` do not create that
queue. Use a named group when its queue must survive consumer restarts, with
durable queue settings enabled. Set `publisherOptions.mandatory: true` to detect
unroutable publishes.
Make handlers idempotent and complete side effects before settlement. See the
[AMQP reliability guide](https://connectum.dev/en/guide/events/amqp-reliability)
for recovery, routing, and settlement behavior.

## Selective routing on a headers exchange

On a headers exchange the adapter cannot derive bindings from a subscription
pattern; selective routing belongs to the application. A headers exchange
delivers a message when any one binding of the queue matches, so in `assert`
mode the adapter adds its own argument-less binding only when
`topology.bindings` declares no binding of that queue to the exchange; a binding
created outside the topology is not seen, and the argument-less binding is added
next to it.

Declare the queue and its `x-match` binding in the topology. The adapter binds
nothing of its own to that queue, so only messages whose headers match reach it:

```typescript
const queue = 'orders.eu';

const adapter = AmqpAdapter({
  url: 'amqp://localhost:5672',
  exchange: 'orders',
  exchangeType: 'headers',
  topology: {
    queues: [{ name: queue, durable: true }],
    bindings: [
      { queue, source: 'orders', routingKey: '', arguments: { 'x-match': 'all', region: 'eu' } },
    ],
  },
  queueOverrides: { eu: { queue } },
});

// Receives only messages published with the header `region: eu`.
await adapter.subscribe(
  ['order.created'],
  async (event, ack) => {
    console.log(event.eventType);
    await ack();
  },
  { group: 'eu' },
);
```

To keep the catch-all for a queue, declare no binding for it, or declare the
binding without arguments. Bindings created outside the topology are not seen
by the adapter; to rely on them use `topologyMode: "check"` or `"skip"`.

> **Behavior change in `assert` mode.** Before this rule, the adapter's
> argument-less binding was added next to the declared ones, so a queue with a
> selective declared binding still received every message. It now receives only
> what the declared bindings select. To keep the old behavior, remove the
> selective binding from `topology.bindings` or declare it without arguments.

## Upgrading a durable queue the previous version bound

The previous version bound a durable queue with an argument-less binding for each subscription
pattern, and the broker keeps those bindings after the upgrade. The adapter
stops adding them but never removes bindings, because it cannot tell its own
from one an operator created; until the operator removes them, the queue still
receives every message and the declared `x-match` binding filters nothing.
Remove every such leftover once (a queue subscribed with several patterns has
one per pattern). The routing key of a leftover is the subscription pattern as
the previous version converted it: a `>` became `#` (`user.>` was bound as
`user.#`), so unbinding with the pattern as written does not remove it. Read the
exact keys from the broker (`rabbitmqctl list_bindings`, or the management API
below) rather than deriving them. The options below were run against RabbitMQ
4.3.6 with a literal key and with a `>` pattern:

- amqplib, with the exact routing key of the leftover and no arguments:
  `await channel.unbindQueue(queue, exchange, routingKey)`. An unbind whose key
  matches no binding completes without an error and removes nothing, so check
  the list afterwards.
- The management HTTP API (the `rabbitmq_management` plugin; `guest:guest` is the
  default user, `%2F` the default vhost). The leftover is the entry with empty
  `arguments`; its `properties_key` goes into the `DELETE`:

  ```bash
  curl -s -u guest:guest http://localhost:15672/api/bindings/%2F/e/<exchange>/q/<queue>
  curl -s -u guest:guest -X DELETE http://localhost:15672/api/bindings/%2F/e/<exchange>/q/<queue>/<properties_key>
  ```

  The `DELETE` answers `204`; the next `GET` lists only the declared binding.
- Delete the queue and let the adapter declare it again with the declared
  binding: `rabbitmqctl delete_queue <queue>`. Its messages are lost.

`rabbitmqctl list_bindings` shows what the broker holds for the queue.

## RabbitMQ versions

Every integration suite runs on RabbitMQ 4.3.6 in CI; the consumer-timeout suite
was also run on 3.13.7, 4.1.8 and 4.2.8. The other suites were not run on those
three lines, and older releases are not tested.

How a consumer that outlives `consumer_timeout` ends depends on the line. On the
4.3 releases that were run (4.3.1 and 4.3.6) the broker cancels the consumer and
keeps the channel (`cause: "cancelled"` in the `consumer-lost` lifecycle event);
on 3.13.7, 4.1.8 and 4.2.8 it closes the whole channel after about two minutes
(`cause: "channel-closed"`). Where the behavior changes between those releases
is inferred, not measured: only these releases were run.

## Running the integration suites against a real broker

The happy-path suite needs only a reachable broker and skips without `AMQP_TEST_URL`:

```bash
docker run -d --name connectum-amqp-test -p 15672:5672 rabbitmq:4.3.6-alpine
until docker exec --user rabbitmq connectum-amqp-test rabbitmq-diagnostics -q check_port_connectivity; do sleep 2; done
AMQP_TEST_URL=amqp://guest:guest@localhost:15672 pnpm --filter @connectum/events-amqp test:integration
```

Probe the broker as the `rabbitmq` user. A `docker exec` as root that reaches the
container before the server has written its Erlang cookie creates the cookie
itself (mode 400, owner root); the server then cannot read it and exits with
`.erlang.cookie: eacces`. The image boots without any extra flag.

The recovery, consumer-loss, consumer-timeout, hardening, ungrouped-queue and
wildcard-routing suites start their own brokers through testcontainers (Docker
required) and run only with `RUN_RECOVERY_TESTS=1`. They use
`rabbitmq:4.3.6-alpine`; set `AMQP_BROKER_IMAGE` to run them against another
version. The hardening and ungrouped-queue suites take a comma separated list
from `AMQP_HARDENING_BROKER_IMAGES` and `AMQP_UNGROUPED_BROKER_IMAGES`, which win
over `AMQP_BROKER_IMAGE` for those two suites.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-amqp)
- [Adapter selection](https://connectum.dev/en/guide/events/adapters#amqp--rabbitmq-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-amqp/types/interfaces/AmqpAdapterOptions)

## License

Apache-2.0

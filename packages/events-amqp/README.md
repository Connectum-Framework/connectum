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

## RabbitMQ versions

Every integration suite runs on RabbitMQ 4.3.6 in CI; the consumer-timeout suite
was also run on 3.13.7, 4.1.8 and 4.2.8. The other suites were not run on those
three lines, and older releases are not tested.

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

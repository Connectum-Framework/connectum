# @connectum/events-kafka

This README documents `@connectum/events-kafka` 1.3 and later.

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

This snippet only connects to Kafka; with no routes, it does not start a
consumer. For routed delivery, a reachable Kafka-compatible broker and the
configured topic/consumer group are required. Unsettled messages can be
redelivered, and a repeatedly failing message can block later messages in its
partition. Make handlers idempotent and see the [acknowledgement and redelivery
guidance](https://connectum.dev/en/guide/events/adapters#kafka-ack-redelivery).

## Connection options

TLS, SASL, timeouts, retry and the client's log level are plain options of
`KafkaAdapter()`, typed by this package and independent of the Kafka client library:

```typescript
KafkaAdapter({
  brokers: ['kafka-1:9093'],
  ssl: { ca: process.env.KAFKA_CA },
  sasl: { mechanism: 'scram-sha-512', username: 'svc', password: process.env.KAFKA_PASSWORD ?? '' },
  requestTimeout: 30_000,
  retry: { retries: 8 },
  logLevel: 'warn',
  producerOptions: { compression: 'gzip' },
});
```

Settings that have no portable form (a log factory, a socket factory, a custom SASL
mechanism) go in `clientOptions`. Its keys are those of the client library the adapter
uses today, they are not type-checked and may change if that library is replaced; it is
merged over the typed options and can never override `brokers` or `clientId`. The old
`kafkaConfig` option is removed and throws; see the
[migration page](https://connectum.dev/en/migration/kafka-adapter-options).

Compression: `gzip` works as shipped. `snappy`, `lz4` and `zstd` need a codec that the
application registers with the client library before the first publish; without one,
publishing fails.

## Broker versions

The integration suite passes on Apache Kafka 4.2.0; other broker versions and
Redpanda are not covered by it.

## Known `TimeoutNegativeWarning` from kafkajs

On Node.js 26, a process using `kafkajs` 2.2.4 can print once at startup:

```text
(node:1234) TimeoutNegativeWarning: -1791406932367 is a negative number.
Timeout duration was set to 1.
```

The warning comes from inside `kafkajs`, not from this adapter: `--trace-warnings`
shows the stack ending in `RequestQueue.scheduleCheckPendingRequests` →
`checkPendingRequests` → `fulfillRequest` → `Connection.processData` →
`Socket.onData`. When the request queue is empty its throttle marker is `-1`, so
`scheduleCheckPendingRequests` computes `-1 - Date.now()` and passes the negative
result to `setTimeout`. Node replaces the delay with 1 ms. The delivery of
messages and the request behavior are unaffected, but the warning is not the
whole effect: when that timer fires, `checkPendingRequests` calls
`scheduleCheckPendingRequests` again, and with an unset throttle marker and an
empty queue it arms the next 1 ms timer, so each broker connection of `kafkajs`
2.2.4 re-arms a 1 ms timer for as long as it stays open and adds that idle
event-loop work. Node.js versions before 26 do the same without printing the
warning. This was established by reading the `kafkajs` 2.2.4 source
(`requestQueue/index.js`); the CPU cost was not measured. No adapter option
reaches this code path. It was observed with the `with-events-kafka` example
services against Apache Kafka 4.2.0; the broker integration suite of this
package, run with the same flag on the same Node.js and broker, did not print it.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/events-kafka)
- [Adapter guide](https://connectum.dev/en/guide/events/adapters#kafka-adapter)
- [API reference](https://connectum.dev/en/api/@connectum/events-kafka/types/interfaces/KafkaAdapterOptions)

## License

Apache-2.0

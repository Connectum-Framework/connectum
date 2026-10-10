# @connectum/events-kafka

## 1.3.0

### Minor Changes

- [#322](https://github.com/Connectum-Framework/connectum/pull/322) [`291e6f8`](https://github.com/Connectum-Framework/connectum/commit/291e6f82212c27846089b16d0d836fded933b17b) Thanks [@intech](https://github.com/intech)! - Add `consumerOptions.commitStrategy` to choose when the consumer group's offset is committed.
  `"per-message"` (the default, unchanged behavior) sends one `OffsetCommit` request for every
  acknowledged message. `"per-batch"` makes `ack()` remember the message and sends a single
  `OffsetCommit` for the last acknowledged one when the adapter stops working on the batch: at its
  end, at a requeued or unsettled message, when the handler throws, when the consumer stops and
  when the group membership is lost. Acknowledged messages are not left uncommitted on any of
  these exits, and an unsettled message is never committed. The trade-off is a larger window of
  duplicates: if the process dies between an `ack()` and the end of the batch, every message
  acknowledged in that batch is delivered again, so handlers must be idempotent. Any other value
  makes `KafkaAdapter()` throw a `RangeError`.

- [#332](https://github.com/Connectum-Framework/connectum/pull/332) [`75588bd`](https://github.com/Connectum-Framework/connectum/commit/75588bdb286dff48ceb2d992aa0d27c28b2671e3) Thanks [@intech](https://github.com/intech)! - fix: a wildcard no longer subscribes Kafka's internal topics; feat: `consumerOptions.topicDiscoveryInterval` picks up topics created after the subscription
  
  - A pattern that opens with a wildcard (`>`, `*`, `*.created`) no longer matches topics whose name starts with `__`, the prefix Kafka and Redpanda use for their internal topics (`__consumer_offsets`, `__transaction_state`). A catch-all `>` used to subscribe `__consumer_offsets` and hand its binary records to the event handler. Literal topic names, a pattern that spells the prefix out (`__audit.>`) and names with a single leading underscore are unaffected, so `>` still receives a topic such as Redpanda's `_schemas`.
  - New `consumerOptions.topicDiscoveryInterval` (`number | false`, milliseconds), **on by default at 300000** (five minutes). KafkaJS expands a wildcard once, when `subscribe()` runs, so a matching topic created later was never consumed until a restart, and the restart read it from the end: what was published to it in between was never handled (measured: 5 of 6 messages). Now the adapter lists the broker's topics every interval and, when a matching topic has appeared, restarts the subscription's consumer to include it, reading the topic from its first message; the discovery is logged with the topic names. The restart rebalances the consumer group (a pause of a few seconds; messages being handled are delivered again) and happens only when there is a new topic. In a group of several members every member must discover the topic before it is read completely, because KafkaJS assigns partitions only from the topic list of the group leader: the delay is up to the longest `topicDiscoveryInterval` among the members, and nothing is lost meanwhile. **Changes the default behaviour of wildcard subscriptions**: one metadata request per wildcard subscription per interval on an extra admin connection, and a group rebalance when a matching topic appears. Set `false` to keep the fixed topic list of earlier versions. A restart inside one interval still misses what was published to a new topic before it.

### Patch Changes

- [#299](https://github.com/Connectum-Framework/connectum/pull/299) [`57a1ab4`](https://github.com/Connectum-Framework/connectum/commit/57a1ab480ab7399a095037d4fa637137b65ca97d) Thanks [@intech](https://github.com/intech)! - fix: acknowledgement now commits the consumer-group offset, and unsettled messages are redelivered in order
  
  - `ack()` and `nack(false)` commit the message offset; previously nothing was committed, so a restarted group received acknowledged messages again, and messages published while a group was stopped could be lost.
  - A handler that throws while its message is still uncommitted, calls `nack(true)`, or (when the adapter is used without the EventBus, which acknowledges a normal return itself) returns without settling ends the batch: that message and the rest of the partition's batch are delivered again, in order. An `ack()` or `nack(false)` that already committed the offset prevents redelivery even if the handler throws afterwards. Previously the message and the rest of its batch were skipped and never redelivered. A failed commit stops the batch and is surfaced to KafkaJS.
  - A handler error is now logged with topic, partition and offset instead of being swallowed.
  - New `consumerOptions.redeliveryDelay` (milliseconds, default `1000`) pauses the partition between redeliveries of an unsettled message; `0` redelivers immediately. On an otherwise idle consumer the observed gap is a whole fetch cycle (5 s in KafkaJS) even for smaller values. A message that fails on every delivery blocks its partition until the handler succeeds, `nack(false)` is called, or the DLQ middleware moves it.
  - `fromBeginning` still defaults to `false`; the README now states what that means for a group without a committed offset.

- [#318](https://github.com/Connectum-Framework/connectum/pull/318) [`850e531`](https://github.com/Connectum-Framework/connectum/commit/850e531c5436d8615ad47888a93b41af5566036a) Thanks [@intech](https://github.com/intech)! - Fix a handler that runs longer than the consumer's `sessionTimeout` being dropped from its
  group and the message redelivered forever. KafkaJS sends a heartbeat only when asked, and the
  adapter asked only between messages, so during a long handler the broker saw no heartbeat,
  removed the member, and every `ack()` then failed with "The coordinator is not aware of this
  member". The adapter now heartbeats in the background for as long as a handler runs and stops as
  soon as the handler returns or throws. If a heartbeat fails and the message was not
  committed, the failure is handed to KafkaJS so the consumer rejoins the group. No option changes.

## 1.2.0

## 1.1.0

## 1.0.0

### Major Changes

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

### Minor Changes

- [#63](https://github.com/Connectum-Framework/connectum/pull/63) [`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca) Thanks [@intech](https://github.com/intech)! - feat: auto-derive broker client identity from proto service names

  EventBus now automatically derives a service identifier from registered proto
  service descriptors (`DescService.typeName`) and passes it to adapters via
  the new `AdapterContext` parameter in `connect()`.

  Format: `{packageNames}@{hostname}` (e.g., `order.v1@pod-abc123`).

  **Adapter behavior** (when no explicit client ID is configured):

  - **Kafka**: uses `serviceName` as `clientId` (visible in broker logs, JMX, ACLs)
  - **NATS**: uses `serviceName` as connection `name` (visible in `/connz`)
  - **Redis**: uses `serviceName` as `connectionName` (visible in `CLIENT LIST`)

  Explicit adapter options (`clientId`, `connectionOptions.name`,
  `redisOptions.connectionName`) always take priority over the derived name.

- [#45](https://github.com/Connectum-Framework/connectum/pull/45) [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c) Thanks [@intech](https://github.com/intech)! - Add EventBus provider with pluggable broker adapters (NATS JetStream, Kafka/Redpanda, Redis Streams).

  **New packages:**

  - `@connectum/events` — Universal event adapter layer with proto-first pub/sub, middleware pipeline, DLQ
  - `@connectum/events-nats` — NATS JetStream adapter with durable consumers
  - `@connectum/events-kafka` — Kafka/Redpanda adapter with consumer groups
  - `@connectum/events-redis` — Redis Streams adapter with XREADGROUP

  **Core integration:**

  - `EventBusLike` interface for server lifecycle integration
  - `createServer({ eventBus })` option with automatic start/stop management

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

- Updated dependencies [[`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`d42e2bd`](https://github.com/Connectum-Framework/connectum/commit/d42e2bdc7229635214abc63553b39d9dee8985b2), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`cd03cb3`](https://github.com/Connectum-Framework/connectum/commit/cd03cb35d66cc5109fc0853089ab659d30c73ccd), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f)]:
  - @connectum/events@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/events@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Updated dependencies [[`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4)]:
  - @connectum/events@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Updated dependencies []:
  - @connectum/events@1.0.0-rc.9

## 1.0.0-rc.8

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`d42e2bd`](https://github.com/Connectum-Framework/connectum/commit/d42e2bdc7229635214abc63553b39d9dee8985b2)]:
  - @connectum/events@1.0.0-rc.8

## 1.0.0-rc.7

### Minor Changes

- [#63](https://github.com/Connectum-Framework/connectum/pull/63) [`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca) Thanks [@intech](https://github.com/intech)! - feat: auto-derive broker client identity from proto service names

  EventBus now automatically derives a service identifier from registered proto
  service descriptors (`DescService.typeName`) and passes it to adapters via
  the new `AdapterContext` parameter in `connect()`.

  Format: `{packageNames}@{hostname}` (e.g., `order.v1@pod-abc123`).

  **Adapter behavior** (when no explicit client ID is configured):

  - **Kafka**: uses `serviceName` as `clientId` (visible in broker logs, JMX, ACLs)
  - **NATS**: uses `serviceName` as connection `name` (visible in `/connz`)
  - **Redis**: uses `serviceName` as `connectionName` (visible in `CLIENT LIST`)

  Explicit adapter options (`clientId`, `connectionOptions.name`,
  `redisOptions.connectionName`) always take priority over the derived name.

### Patch Changes

- Updated dependencies [[`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca)]:
  - @connectum/events@1.0.0-rc.7

## 1.0.0-rc.6

### Minor Changes

- [#45](https://github.com/Connectum-Framework/connectum/pull/45) [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c) Thanks [@intech](https://github.com/intech)! - Add EventBus provider with pluggable broker adapters (NATS JetStream, Kafka/Redpanda, Redis Streams).

  **New packages:**

  - `@connectum/events` — Universal event adapter layer with proto-first pub/sub, middleware pipeline, DLQ
  - `@connectum/events-nats` — NATS JetStream adapter with durable consumers
  - `@connectum/events-kafka` — Kafka/Redpanda adapter with consumer groups
  - `@connectum/events-redis` — Redis Streams adapter with XREADGROUP

  **Core integration:**

  - `EventBusLike` interface for server lifecycle integration
  - `createServer({ eventBus })` option with automatic start/stop management

### Patch Changes

- Updated dependencies [[`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c)]:
  - @connectum/events@1.0.0-rc.6

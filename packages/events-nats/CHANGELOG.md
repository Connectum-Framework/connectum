# @connectum/events-nats

## 1.3.0

### Minor Changes

- [#362](https://github.com/Connectum-Framework/connectum/pull/362) [`b18aec6`](https://github.com/Connectum-Framework/connectum/commit/b18aec616e31bfbe9f7588eee029f7f447dbaedc) Thanks [@intech](https://github.com/intech)! - feat: `NatsAdapter` reports its connection lifecycle through `lifecycle.onLifecycle`, the same pattern as `@connectum/events-amqp`. Until now an operator could not observe or alert on the broker connection of the NATS adapter, and a client that gave up reconnecting left the adapter unusable without any signal.
  
  The events (a union on `type`, local to this package): `connected { reconnected }` once after the first connect and once per recovery (`server` set), `disconnected { server }` once per loss, `reconnecting { attempt }` for every dial after a loss (the client reports one per address it tries; it reports no delay or error, so none is given), and the terminal `reconnect-failed { error }` when the client closes itself without a `disconnect()` call, typically after its reconnect budget ran out. `staleConnection`, `forceReconnect`, `error`, `ldm`, `update`, `ping` and `slowConsumer` produce nothing. `disconnect()` produces no loss event. A callback that throws or returns a rejected promise is isolated and reported once as `lifecycle-error`; a returned promise is not awaited, so a slow callback never delays `disconnect()`.
  
  Without the option no listener is attached to the client and nothing changes. Events of the initial dial that happen before `connect()` returns are not available from the client. After `reconnect-failed` the adapter drops the dead connection: `publish()` rejects with "not connected" and `connect()` can start a fresh connection (before, it kept refusing with "already connected" until `disconnect()` was called).

### Patch Changes

- [#409](https://github.com/Connectum-Framework/connectum/pull/409) [`df9c0b7`](https://github.com/Connectum-Framework/connectum/commit/df9c0b7d90b9e27b77cb7d9a94a2b129743bed25) Thanks [@intech](https://github.com/intech)! - fix: `consumerOptions.deliverPolicy: "last"` now delivers the last message of every matching subject, as the `NatsConsumerOptions` reference says, instead of only the single last message that matches the filter. The adapter maps `"last"` to the JetStream policy `last_per_subject`. For a literal pattern nothing changes (one subject, one last message). For a wildcard pattern such as `orders.*` a new consumer now starts with the last message of each subject; with overlapping patterns every event is still handled once.
  
  A durable consumer that was already created with the old policy keeps it: the adapter does not rewrite an existing consumer, it reports the difference once through a warning (`deliver_policy=last (requested last_per_subject)`) and goes on with the existing configuration. To get the new behaviour for such a group, delete its durable consumer or use a new group name.

- [#417](https://github.com/Connectum-Framework/connectum/pull/417) [`93b125f`](https://github.com/Connectum-Framework/connectum/commit/93b125fe672a49219ce20491fdfde41cf09f4f32) Thanks [@intech](https://github.com/intech)! - fix: `subscribe()` now refuses, before it reaches the broker, the subscription patterns that the adapter's broker cannot serve, with a `TypeError` that names the adapter and the pattern. NATS and the in-memory adapter refuse a pattern with an empty token (the empty string, `a..b`, `.a`, `a.` and `.`); Kafka refuses `""`, `.` and `..`, the topic names Kafka reserves. Other adapters are unchanged: `a..b`, `.a` and `a.` stay valid Kafka topic names, and Redis and RabbitMQ accept any key.
  
  Earlier versions accepted these patterns and failed late: `NatsAdapter` with `jetstream is not enabled` (the server never answers a consumer request whose subject has an empty token), `KafkaAdapter` with `invalid topic` after it had connected a consumer. A bad pattern next to good ones now leaves no consumer or consumer group behind, and `EventBus.start()` fails with the new error. `@connectum/events` exports the check as `assertSubscriptionPatterns({ adapter, patterns, rule })` for custom adapters; `rule` is `"no-empty-segment"` (default) or `"kafka-topic-name"`.

- [#422](https://github.com/Connectum-Framework/connectum/pull/422) [`5c77117`](https://github.com/Connectum-Framework/connectum/commit/5c77117022504200ec4604f748614568320f0a9f) Thanks [@intech](https://github.com/intech)! - fix: `publish()` now refuses, before it reaches the broker, the topics that the adapter's broker cannot serve, with a `TypeError` that names the adapter and the topic. NATS and the in-memory adapter refuse a topic with an empty token (the empty string, `a..b`, `.a`, `a.` and `.`); Kafka refuses `""`, `.` and `..`, the topic names Kafka reserves. This is the publishing side of the check `subscribe()` already makes. Other adapters are unchanged: `a..b`, `.a` and `a.` stay valid Kafka topics, and Redis and RabbitMQ accept any key.
  
  Earlier versions failed late or not at all: `NatsAdapter` answered every one of these topics with `jetstream is not enabled` and stored nothing, `KafkaAdapter` answered its reserved names with a broker error that does not name the topic, and `MemoryAdapter` delivered the event to wildcard subscribers although no subscription pattern could name that topic. `@connectum/events` exports the check as `assertPublishTopic({ adapter, topic, rule })` for custom adapters, with the same `rule` values as `assertSubscriptionPatterns`.

- [#332](https://github.com/Connectum-Framework/connectum/pull/332) [`75588bd`](https://github.com/Connectum-Framework/connectum/commit/75588bdb286dff48ceb2d992aa0d27c28b2671e3) Thanks [@intech](https://github.com/intech)! - fix: an event matched by several patterns of one subscription is handled once
  
  A JetStream consumer delivers a stream message once, and the adapter keeps one durable consumer per pattern, so a route set such as `user.created`, `user.*`, `user.>` ran the handler three times for a single `user.created`. The adapter now runs the handler for one of those deliveries, the one of the most specific pattern whose consumer delivers the event (fewer `>`, then fewer `*`, then more tokens, then the pattern text; the same on every replica), and acknowledges the others without running it. Partly overlapping patterns (`a.*.c`, `a.b.*`) need no special case.
  
  The consumer layout on the broker does not change: same durable names, same filters, one consumer per pattern. Upgrading or rolling back needs no action, and the backlog of consumers that already exist (events published while the service was down) is delivered once. The network still carries one copy per matching pattern.
  
  The adapter reads the consumers it finds and never changes their configuration, so an earlier version of the adapter can start again after a rollback (a consumer created again with the same configuration is accepted by every supported server), and consumers provisioned by an operator need only read and pull permissions. Replicas compute where each consumer starts from what the server reports; a delivery below that bound still runs the handler, so replicas that disagree can run a handler twice for an event, never zero times. When an existing consumer was made with another `ackWait`, `maxDeliver` or `deliverPolicy` than the subscription asks for, the adapter keeps it and logs one warning per consumer.
  
  While a service is rolled out with a route added to a broader pattern, an event can be handled by both the old and the new replicas, so a handler may see it twice but never zero times; that is the at-least-once contract. `subscribe()` that fails half-way now removes only the consumers of an auto-generated group; the consumers of a named group stay for the next start (before, a failing call also deleted a consumer of the group that existed already, which stops the replica reading it without an error).

- [#325](https://github.com/Connectum-Framework/connectum/pull/325) [`3591014`](https://github.com/Connectum-Framework/connectum/commit/35910149aa614a388cfadbb11968b3deb57aad13) Thanks [@intech](https://github.com/intech)! - docs: the package READMEs are short entry points (install, a runnable start, constraints, links) and the long reference tables now live on the documentation site and in the API reference. The facts that exist only in a README stay there: the cancellation migration notes of `@connectum/interceptors`, the request initializer migration of `@connectum/protoc-gen-catalog`, the dependency injection and testing section of `@connectum/events`, the verified RabbitMQ and Kafka broker lines and the integration-suite instructions of the AMQP and Kafka adapters. Examples in the READMEs of eight packages and the Quickstart are executed against the packed packages by `pnpm docs:check`. JSDoc of a few exports was corrected to match the code; no runtime behavior changes.

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

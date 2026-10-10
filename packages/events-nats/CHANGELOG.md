# @connectum/events-nats

## 1.3.0

### Patch Changes

- [#332](https://github.com/Connectum-Framework/connectum/pull/332) [`75588bd`](https://github.com/Connectum-Framework/connectum/commit/75588bdb286dff48ceb2d992aa0d27c28b2671e3) Thanks [@intech](https://github.com/intech)! - fix: an event matched by several patterns of one subscription is handled once
  
  A JetStream consumer delivers a stream message once, and the adapter keeps one durable consumer per pattern, so a route set such as `user.created`, `user.*`, `user.>` ran the handler three times for a single `user.created`. The adapter now runs the handler for one of those deliveries, the one of the most specific pattern whose consumer delivers the event (fewer `>`, then fewer `*`, then more tokens, then the pattern text; the same on every replica), and acknowledges the others without running it. Partly overlapping patterns (`a.*.c`, `a.b.*`) need no special case.
  
  The consumer layout on the broker does not change: same durable names, same filters, one consumer per pattern. Upgrading or rolling back needs no action, and the backlog of consumers that already exist (events published while the service was down) is delivered once. The network still carries one copy per matching pattern.
  
  The adapter reads the consumers it finds and never changes their configuration, so an earlier version of the adapter can start again after a rollback (a consumer created again with the same configuration is accepted by every supported server), and consumers provisioned by an operator need only read and pull permissions. Replicas compute where each consumer starts from what the server reports; a delivery below that bound still runs the handler, so replicas that disagree can run a handler twice for an event, never zero times. When an existing consumer was made with another `ackWait`, `maxDeliver` or `deliverPolicy` than the subscription asks for, the adapter keeps it and logs one warning per consumer.
  
  While a service is rolled out with a route added to a broader pattern, an event can be handled by both the old and the new replicas, so a handler may see it twice but never zero times; that is the at-least-once contract. `subscribe()` that fails half-way now removes only the consumers of an auto-generated group; the consumers of a named group stay for the next start (before, a failing call also deleted a consumer of the group that existed already, which stops the replica reading it without an error).

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

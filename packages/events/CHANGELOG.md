# @connectum/events

## 1.0.0-rc.10

### Minor Changes

- [#91](https://github.com/Connectum-Framework/connectum/pull/91) [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4) Thanks [@intech](https://github.com/intech)! - feat(events): support per-handler middleware configuration

  Event handlers registered via `router.service()` can now specify per-handler
  middleware that overrides the global EventBus middleware pipeline.

  Handlers support two forms:

  - Simple function: `onEvent: async (msg, ctx) => { ... }` (uses global middleware)
  - Config object: `onEvent: { handler: async (msg, ctx) => { ... }, middleware: [...] }` (per-handler override)

  Closes [#49](https://github.com/Connectum-Framework/connectum/issues/49)

- [#91](https://github.com/Connectum-Framework/connectum/pull/91) [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4) Thanks [@intech](https://github.com/intech)! - feat(events): auto-resolve publish topic from proto annotations

  EventBus.publish() now automatically resolves the topic from proto
  `(connectum.events.v1.event).topic` option when no explicit topic is
  provided in PublishOptions. This eliminates the need to manually
  duplicate topic strings between proto definitions and publish calls.

  Priority order:

  1. Explicit `publishOptions.topic` (override)
  2. Proto annotation topic (auto-resolved from registered routes)
  3. `schema.typeName` (fallback, backward compatible)

### Patch Changes

- [#91](https://github.com/Connectum-Framework/connectum/pull/91) [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4) Thanks [@intech](https://github.com/intech)! - fix(events): preserve concrete input types in ServiceEventHandlers

  Changed `ServiceEventHandlers` mapped type to derive handler input types from
  `S["method"]` (concrete GenService record) instead of `S["methods"][number]`
  (generic DescMethod array). This preserves concrete protobuf message types
  in event handlers, eliminating the need for `as unknown as T` casts.

  Closes [#86](https://github.com/Connectum-Framework/connectum/issues/86)

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.9

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

- [#67](https://github.com/Connectum-Framework/connectum/pull/67) [`d42e2bd`](https://github.com/Connectum-Framework/connectum/commit/d42e2bdc7229635214abc63553b39d9dee8985b2) Thanks [@intech](https://github.com/intech)! - Fix composeMiddleware to support retry middleware

  The handler branch (dispatch terminal case) was outside the try/catch
  block, so handler errors did not reset the dispatch index. This caused
  retry middleware to hit the "next() called multiple times" guard on
  subsequent attempts instead of actually retrying.

  Moved handler into try/catch and added await for proper error propagation.

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda)]:
  - @connectum/core@1.0.0-rc.8

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

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.7

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
  - @connectum/core@1.0.0-rc.6

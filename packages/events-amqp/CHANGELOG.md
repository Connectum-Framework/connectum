# @connectum/events-amqp

## 1.1.0

### Minor Changes

- [#185](https://github.com/Connectum-Framework/connectum/pull/185) [`cc5a42c`](https://github.com/Connectum-Framework/connectum/commit/cc5a42cf7325889009a372e96554a749c6cf0887) Thanks [@intech](https://github.com/intech)! - Add `publisherOptions.externalContract` for publishing against an external (non-EventBus) AMQP/AsyncAPI contract. When set, the adapter suppresses the EventBus envelope so the wire frame carries only contract-specified properties — no `x-event-id` / `x-published-at` headers, no auto-populated `messageId` / `timestamp`, and (for `mandatory` publishes) single-flight correlation so no `x-connectum-publish-id` header reaches the wire (`correlationHeader` is ignored in this mode). The frame then carries only `contentType`, `persistent`/deliveryMode, `mandatory`, and the headers supplied via `PublishOptions.metadata`.

  This closes the gap where `correlationHeader: false` was documented as yielding a "clean wire" but the envelope still shipped ([#161](https://github.com/Connectum-Framework/connectum/issues/161)). Default (EventBus) behavior is unchanged: the envelope is stamped on publish and stripped on delivery. Verified with a raw amqplib consumer against a real broker. A caller-controlled `messageId` / `timestamp` (needs a cross-package `PublishOptions` field) remains a documented follow-up.

- [#186](https://github.com/Connectum-Framework/connectum/pull/186) [`ac41deb`](https://github.com/Connectum-Framework/connectum/commit/ac41deb0641ed4027b53fa7bc82a23312cfccdaa) Thanks [@intech](https://github.com/intech)! - Add `PublishOptions.messageId` and `PublishOptions.timestamp` (Unix epoch seconds) so a caller can set the message identity an external contract requires. Adapters honor them where supported and ignore them otherwise; `@connectum/events-amqp` maps them to the AMQP `messageId` / `timestamp` properties.

  This completes the external-contract publish path ([#161](https://github.com/Connectum-Framework/connectum/issues/161)): in `externalContract` mode the adapter auto-generates nothing, so a caller-supplied `messageId` / `timestamp` is the way to populate those wire properties when the contract demands them. A supplied value is used as-is in any mode; auto-generation still applies only in non-external mode when the caller omits them.

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

- [#65](https://github.com/Connectum-Framework/connectum/pull/65) [`4f2705b`](https://github.com/Connectum-Framework/connectum/commit/4f2705bbd8a86eb57419baf81c292da9f5e8b841) Thanks [@intech](https://github.com/intech)! - Add @connectum/events-amqp — AMQP 0-9-1 / RabbitMQ adapter for EventBus

  New package providing AMQP adapter for @connectum/events:

  - RabbitMQ and LavinMQ compatibility
  - Topic exchange for wildcard routing
  - Durable queues with competing consumers
  - Message headers for metadata propagation
  - Dead letter exchange integration with DLQ middleware
  - Automatic client identification via connection name

- [#140](https://github.com/Connectum-Framework/connectum/pull/140) [`cd03cb3`](https://github.com/Connectum-Framework/connectum/commit/cd03cb35d66cc5109fc0853089ab659d30c73ccd) Thanks [@intech](https://github.com/intech)! - External AMQP contracts, automatic recovery, and reliable per-message publishing.

  The adapter can now implement an externally agreed AMQP contract (AsyncAPI-style) and survive broker outages:

  - **Serialization**: `serialization: { contentType, encode, decode }` — set the message `contentType` (e.g. `application/json` for JSON contracts; default stays `application/protobuf`) and optionally transcode the wire body.
  - **Explicit topology**: `topology: { exchanges, queues, bindings }` with arbitrary external names and raw AMQP `arguments` (incl. `x-dead-letter-exchange`), exchange-to-exchange bindings, plus `topologyMode: "assert" | "check" | "skip"` for app-owned topology with fail-fast existence checks.
  - **queueOverrides**: attach a consumer group to an externally named queue instead of `${exchange}.${group}`.
  - **Automatic recovery** (amqplib v2 native opt-in recovery, enabled by default): reconnect with backoff/jitter, re-created channels, re-applied topology, replayed subscriptions. `lifecycle` callbacks (`onConnected` / `onDisconnected` / `onReconnecting` / `onReconnectFailed`) replace console-only error reporting. With recovery enabled `connect()` waits for the broker (docker-compose friendly); `recovery: false` restores fail-fast.
  - **Reliable publishing**: every `publish()` resolves on its own broker ack and rejects with a typed error — `AmqpUnroutableError` (mandatory + `basic.return`, correlated via a private `x-connectum-publish-id` header; opt-out `correlationHeader: false` switches to single-flight), `AmqpPublishNackError`, `AmqpPublishTimeoutError` (`publishTimeoutMs`, default 30 s), `AmqpConnectionError`, `AmqpTopologyError`, `AmqpSerializationError`.

  Deprecations / behavioral notes:

  - The `sync` publish flag is now a no-op in this adapter — confirms are always per-message.
  - `mandatory: true` publishes stamp the `x-connectum-publish-id` header on the wire (visible to external consumers; documented; opt-out available).
  - Dependency: `amqplib` upgraded `^1.0.3` → `^2.0.1`.

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

- [#65](https://github.com/Connectum-Framework/connectum/pull/65) [`4f2705b`](https://github.com/Connectum-Framework/connectum/commit/4f2705bbd8a86eb57419baf81c292da9f5e8b841) Thanks [@intech](https://github.com/intech)! - Add @connectum/events-amqp — AMQP 0-9-1 / RabbitMQ adapter for EventBus

  New package providing AMQP adapter for @connectum/events:

  - RabbitMQ and LavinMQ compatibility
  - Topic exchange for wildcard routing
  - Durable queues with competing consumers
  - Message headers for metadata propagation
  - Dead letter exchange integration with DLQ middleware
  - Automatic client identification via connection name

### Patch Changes

- Updated dependencies [[`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca)]:
  - @connectum/events@1.0.0-rc.7

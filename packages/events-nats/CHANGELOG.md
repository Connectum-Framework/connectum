# @connectum/events-nats

## 1.3.0

### Minor Changes

- [#646](https://github.com/Connectum-Framework/connectum/pull/646) [`d09aa58`](https://github.com/Connectum-Framework/connectum/commit/d09aa58423d6479dbd2e950736261287f6fc9ea4) Thanks [@intech](https://github.com/intech)! - feat: add `consumerOptions.prefetch`, the number of messages the server may hand to one consumer ahead of its handler. The server starts the `ackWait` timer of a message when it delivers the message to the client's buffer, and the handler runs one message at a time, so with the client's default buffer of 100 a single consumer received duplicates as soon as `handler time x buffer position` outgrew `ackWait` (measured on JetStream 2.11 with `ackWait: 1500`: 8 messages of 400 ms each arrived 13 times; with `prefetch: 1` they arrive 8 times). The default is unchanged (the client's own buffer of 100); set a small `prefetch` for handlers that take long compared with `ackWait / 100`. An integer from 1 to 2147483647 is accepted, anything else makes `NatsAdapter()` throw.

- [#646](https://github.com/Connectum-Framework/connectum/pull/646) [`d09aa58`](https://github.com/Connectum-Framework/connectum/commit/d09aa58423d6479dbd2e950736261287f6fc9ea4) Thanks [@intech](https://github.com/intech)! - fix: the NATS adapter delivers the metadata a caller published as it was given. It used to drop every key that starts with `x-` on publish and every empty value on receive, so a handler that read `x-request-id` saw it on Redis and in memory but not on NATS. Only `x-event-id` stays the adapter's own: it carries the event id the adapter generates and a value passed in `metadata` is ignored, as before. A handler that relied on such a key being absent now sees it.

- [#362](https://github.com/Connectum-Framework/connectum/pull/362) [`b18aec6`](https://github.com/Connectum-Framework/connectum/commit/b18aec616e31bfbe9f7588eee029f7f447dbaedc) Thanks [@intech](https://github.com/intech)! - feat: `NatsAdapter` reports its connection lifecycle through `lifecycle.onLifecycle`, the same pattern as `@connectum/events-amqp`. Until now an operator could not observe or alert on the broker connection of the NATS adapter, and a client that gave up reconnecting left the adapter unusable without any signal.
  
  The events (a union on `type`, local to this package): `connected { reconnected }` once after the first connect and once per recovery (`server` set), `disconnected { server }` once per loss, `reconnecting { attempt }` for every dial after a loss (the client reports one per address it tries; it reports no delay or error, so none is given), and the terminal `reconnect-failed { error }` when the client closes itself without a `disconnect()` call, typically after its reconnect budget ran out. `staleConnection`, `forceReconnect`, `error`, `ldm`, `update`, `ping` and `slowConsumer` produce nothing. `disconnect()` produces no loss event. A callback that throws or returns a rejected promise is isolated and reported once as `lifecycle-error`; a returned promise is not awaited, so a slow callback never delays `disconnect()`.
  
  Without the option no listener is attached to the client and nothing changes. Events of the initial dial that happen before `connect()` returns are not available from the client. After `reconnect-failed` the adapter drops the dead connection: `publish()` rejects with "not connected" and `connect()` can start a fresh connection (before, it kept refusing with "already connected" until `disconnect()` was called).

- [#646](https://github.com/Connectum-Framework/connectum/pull/646) [`d09aa58`](https://github.com/Connectum-Framework/connectum/commit/d09aa58423d6479dbd2e950736261287f6fc9ea4) Thanks [@intech](https://github.com/intech)! - feat: add `consumerOptions.redeliveryDelay`, an opt-in pause between a handler failure and the redelivery of the message, and report the delivery that uses up `maxDeliver`. A raw handler that throws used to get the message back at once (`nak()` without a delay), so the five deliveries of the default `maxDeliver` arrived within 4 ms (measured on JetStream 2.11 and 2.9.25) and nothing was logged. With `redeliveryDelay: 1000` the server holds the message for one second after each failure. The default is unchanged (`0`, redeliver at once), the pause does not apply to an explicit `nack()`, and the server keeps counting each delivery against `maxDeliver`, so a delay does not replace the `retry` and `dlq` middleware for a message that can never succeed. When a handler failure or `nack()` gives a message back on the last delivery the consumer allows, the adapter now logs one `[EventBus/NATS]` error line naming the topic, the consumer, the stream and the limit; the message stays in the stream until retention removes it, as before. A `redeliveryDelay` that is not an integer from `0` to `2147483647` makes `NatsAdapter()` throw.

- [#646](https://github.com/Connectum-Framework/connectum/pull/646) [`d09aa58`](https://github.com/Connectum-Framework/connectum/commit/d09aa58423d6479dbd2e950736261287f6fc9ea4) Thanks [@intech](https://github.com/intech)! - fix: a NATS subscription resumes after its JetStream stream was deleted and created again. Deleting a stream deletes its consumers; the client kept asking for a consumer that no longer existed, so `publish()` worked again after the stream was back while the handler never ran again, and nothing was logged. The adapter now logs the loss (`[EventBus/NATS] The server lost consumer ...`), polls for the stream (the pause grows to 5 seconds), creates the consumer again from the first message of the new stream (every message in it was published after the loss), replaces the client's message stream, and logs that delivery resumes; `unsubscribe()` and `disconnect()` stop the wait. A consumer that was deleted on its own while its stream still exists is not created again, as before, but the deletion is now logged once instead of passing silently. The adapter still does not create a deleted stream, and it gives up, with a log line, when the client has closed the connection for good. An acknowledgement a handler sends after the server lost its consumer is dropped, because the server matches acknowledgements by stream sequence and it could settle a different message of the new stream. With overlapping patterns in one subscription, an event can run the handler twice while the consumers of the patterns are being recreated, and is never skipped.

- [#646](https://github.com/Connectum-Framework/connectum/pull/646) [`d09aa58`](https://github.com/Connectum-Framework/connectum/commit/d09aa58423d6479dbd2e950736261287f6fc9ea4) Thanks [@intech](https://github.com/intech)! - fix: `NatsAdapter()` validates its options when the adapter is created and throws an error that names the option, instead of replacing the value silently or failing later at the server. Rejected: `servers` that is not a non-empty string or a non-empty array of non-empty strings (`[]` used to dial the local default address), `consumerOptions.ackWait` that is not a finite number of milliseconds greater than 0 (`0` used to become the 30 s default, a negative number made the server redeliver at once), `consumerOptions.maxDeliver` other than `-1` or a positive integer (`0`, `-2` and `1.5` were accepted or refused only by the server at the first `subscribe()`), `consumerOptions.deliverPolicy` other than `"new"`, `"all"` or `"last"` (an unknown value used to behave like `"new"`), and a missing or non-object `options` or `consumerOptions`. A fractional `ackWait` is sent as whole nanoseconds. A configuration that passed one of the rejected values now fails at start-up; valid values behave as before.

### Patch Changes

- [#409](https://github.com/Connectum-Framework/connectum/pull/409) [`df9c0b7`](https://github.com/Connectum-Framework/connectum/commit/df9c0b7d90b9e27b77cb7d9a94a2b129743bed25) Thanks [@intech](https://github.com/intech)! - fix: `consumerOptions.deliverPolicy: "last"` now delivers the last message of every matching subject, as the `NatsConsumerOptions` reference says, instead of only the single last message that matches the filter. The adapter maps `"last"` to the JetStream policy `last_per_subject`. For a literal pattern nothing changes (one subject, one last message). For a wildcard pattern such as `orders.*` a new consumer now starts with the last message of each subject; with overlapping patterns every event is still handled once.
  
  A durable consumer that was already created with the old policy keeps it: the adapter does not rewrite an existing consumer, it reports the difference once through a warning (`deliver_policy=last (requested last_per_subject)`) and goes on with the existing configuration. To get the new behaviour for such a group, delete its durable consumer or use a new group name.

- [#417](https://github.com/Connectum-Framework/connectum/pull/417) [`93b125f`](https://github.com/Connectum-Framework/connectum/commit/93b125fe672a49219ce20491fdfde41cf09f4f32) Thanks [@intech](https://github.com/intech)! - fix: `subscribe()` now refuses, before it reaches the broker, the subscription patterns that the adapter's broker cannot serve, with a `TypeError` that names the adapter and the pattern. NATS and the in-memory adapter refuse a pattern with an empty token (the empty string, `a..b`, `.a`, `a.` and `.`); Kafka refuses `""`, `.` and `..`, the topic names Kafka reserves. Other adapters are unchanged: `a..b`, `.a` and `a.` stay valid Kafka topic names, and Redis and RabbitMQ accept any key.
  
  Earlier versions accepted these patterns and failed late: `NatsAdapter` with `jetstream is not enabled` (the server never answers a consumer request whose subject has an empty token), `KafkaAdapter` with `invalid topic` after it had connected a consumer. A bad pattern next to good ones now leaves no consumer or consumer group behind, and `EventBus.start()` fails with the new error. `@connectum/events` exports the check as `assertSubscriptionPatterns({ adapter, patterns, rule })` for custom adapters; `rule` is `"no-empty-segment"` (default) or `"kafka-topic-name"`.

- [#422](https://github.com/Connectum-Framework/connectum/pull/422) [`5c77117`](https://github.com/Connectum-Framework/connectum/commit/5c77117022504200ec4604f748614568320f0a9f) Thanks [@intech](https://github.com/intech)! - fix: `publish()` now refuses, before it reaches the broker, the topics that the adapter's broker cannot serve, with a `TypeError` that names the adapter and the topic. NATS and the in-memory adapter refuse a topic with an empty token (the empty string, `a..b`, `.a`, `a.` and `.`); Kafka refuses `""`, `.` and `..`, the topic names Kafka reserves. This is the publishing side of the check `subscribe()` already makes. Other adapters are unchanged: `a..b`, `.a` and `a.` stay valid Kafka topics, and Redis and RabbitMQ accept any key.
  
  Earlier versions failed late or not at all: `NatsAdapter` answered every one of these topics with `jetstream is not enabled` and stored nothing, `KafkaAdapter` answered its reserved names with a broker error that does not name the topic, and `MemoryAdapter` delivered the event to wildcard subscribers although no subscription pattern could name that topic. `@connectum/events` exports the check as `assertPublishTopic({ adapter, topic, rule })` for custom adapters, with the same `rule` values as `assertSubscriptionPatterns`.

- [#651](https://github.com/Connectum-Framework/connectum/pull/651) [`70b91ca`](https://github.com/Connectum-Framework/connectum/commit/70b91caeffef5753cef81dccd1bfe2fdd7b50a93) Thanks [@intech](https://github.com/intech)! - fix: every package manifest now carries `homepage` (the package page on https://connectum.dev), `bugs.url` (the repository issue tracker) and one `repository` form (`git+https://github.com/Connectum-Framework/connectum.git` plus the package `directory`). Before, none of the 15 packages declared `homepage` or `bugs`, so the npm package page had no documentation or issue links and `npm docs` / `npm bugs` had nothing to open; the four events adapters also wrote `repository.url` without the `git+` prefix. The release gate now fails if any installed package differs from this form.

- [`07fccd9`](https://github.com/Connectum-Framework/connectum/commit/07fccd9117c16c6be04ba71e5b4e40439aa65703) Thanks [@intech](https://github.com/intech)! - fix: closing a subscription no longer strands a message for `ack_wait`. The client forgot the subscription the moment it began to close, while the server learned of it only when the unsubscribe arrived. A message the server dispatched to the consumer's pending pull request in between reached a subscription the client no longer knew and was dropped without a trace; it stayed awaiting an acknowledgement until `ack_wait` (30 s by default) ran out, so the next consumer of the group received it that much later. This showed on `EventBus.stop()` and on the abort of the shutdown signal for a message published within milliseconds of the close.
  
  `unsubscribe()` now drains the subscription first: it sends the unsubscribe, waits for the server to confirm it (bounded to 5 s, so a lost connection does not hold the close) and keeps receiving meanwhile. A message that still arrives reaches the consume loop and goes back to the group through the handler, which the bus nacks once reception has ended.

- [#646](https://github.com/Connectum-Framework/connectum/pull/646) [`d09aa58`](https://github.com/Connectum-Framework/connectum/commit/d09aa58423d6479dbd2e950736261287f6fc9ea4) Thanks [@intech](https://github.com/intech)! - fix: a connect, publish or subscribe that times out says what it was doing. The NATS client reports every unanswered request as `TimeoutError: timeout` (after 20 s for the connection, 5 s for a JetStream request), which names neither the topic nor the servers. The message now starts with the action: `NatsAdapter: connect to <servers> did not complete in time: timeout`, `NatsAdapter: publish to topic "<topic>" on stream "<stream>" was not acknowledged in time: timeout`, `NatsAdapter: subscribe to topics [...] on stream "<stream>" did not complete in time: timeout`. The error keeps its class, `name` and `cause`; the original text stays at the end; a topic longer than 100 characters is cut and its length given. Other errors are unchanged.

- [#332](https://github.com/Connectum-Framework/connectum/pull/332) [`75588bd`](https://github.com/Connectum-Framework/connectum/commit/75588bdb286dff48ceb2d992aa0d27c28b2671e3) Thanks [@intech](https://github.com/intech)! - fix: an event matched by several patterns of one subscription is handled once
  
  A JetStream consumer delivers a stream message once, and the adapter keeps one durable consumer per pattern, so a route set such as `user.created`, `user.*`, `user.>` ran the handler three times for a single `user.created`. The adapter now runs the handler for one of those deliveries, the one of the most specific pattern whose consumer delivers the event (fewer `>`, then fewer `*`, then more tokens, then the pattern text; the same on every replica), and acknowledges the others without running it. Partly overlapping patterns (`a.*.c`, `a.b.*`) need no special case.
  
  The consumer layout on the broker does not change: same durable names, same filters, one consumer per pattern. Upgrading or rolling back needs no action, and the backlog of consumers that already exist (events published while the service was down) is delivered once. The network still carries one copy per matching pattern.
  
  The adapter reads the consumers it finds and never changes their configuration, so an earlier version of the adapter can start again after a rollback (a consumer created again with the same configuration is accepted by every supported server), and consumers provisioned by an operator need only read and pull permissions. Replicas compute where each consumer starts from what the server reports; a delivery below that bound still runs the handler, so replicas that disagree can run a handler twice for an event, never zero times. When an existing consumer was made with another `ackWait`, `maxDeliver` or `deliverPolicy` than the subscription asks for, the adapter keeps it and logs one warning per consumer.
  
  While a service is rolled out with a route added to a broader pattern, an event can be handled by both the old and the new replicas, so a handler may see it twice but never zero times; that is the at-least-once contract. `subscribe()` that fails half-way now removes only the consumers of an auto-generated group; the consumers of a named group stay for the next start (before, a failing call also deleted a consumer of the group that existed already, which stops the replica reading it without an error).

- [#656](https://github.com/Connectum-Framework/connectum/pull/656) [`4bb64df`](https://github.com/Connectum-Framework/connectum/commit/4bb64df21cc0d32d1008f9e18a5956dd8d660cef) Thanks [@intech](https://github.com/intech)! - fix: a subscription whose request for messages reaches a server that no longer has the consumer resumes at once. When the handler of a message was still running while the JetStream stream was deleted and created again, the client's next request for messages got "no responders" instead of "consumer deleted"; the adapter ignored that answer and the subscription stayed silent until the client noticed missed heartbeats, 30 to 45 seconds later. The adapter now asks the server whether the consumer exists and, when the consumer or its stream is gone, recovers exactly as for "consumer deleted". An answer that only reflects a server that is busy or restarting leaves the subscription alone.

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

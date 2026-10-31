# @connectum/events-redis

## 1.3.0

### Minor Changes

- [#254](https://github.com/Connectum-Framework/connectum/pull/254) [`d9f9fb4`](https://github.com/Connectum-Framework/connectum/commit/d9f9fb4f3360a906a0404a0feeda45d026a5cadd) Thanks [@intech](https://github.com/intech)! - Add configurable RESP2 and RESP3 Redis Streams support while preserving RESP2 as the backward-compatible default, and refresh the Redis, AMQP testcontainer, and authentication dependencies.

- [#630](https://github.com/Connectum-Framework/connectum/pull/630) [`d3c9f99`](https://github.com/Connectum-Framework/connectum/commit/d3c9f99e6f3a1ad214bf10001209c5956cca35a6) Thanks [@intech](https://github.com/intech)! - feat: `RedisAdapter()` validates `brokerOptions` when it is called and throws a `RangeError` that names the option and the received value. `maxLen` and `count` must be positive safe integers and `blockMs` a non-negative safe integer; `undefined` keeps the default. Previously `maxLen: 0` made every `XADD ... MAXLEN ~ 0` trim the entry it had just added, so published events vanished without an error, and an invalid `blockMs` or `count` started successfully and then failed every second inside the consume loop so that nothing was ever delivered. Valid values behave as before.

- [#630](https://github.com/Connectum-Framework/connectum/pull/630) [`d3c9f99`](https://github.com/Connectum-Framework/connectum/commit/d3c9f99e6f3a1ad214bf10001209c5956cca35a6) Thanks [@intech](https://github.com/intech)! - fix: `connect()` and `subscribe()` no longer wait forever for a Redis server that accepts the TCP connection and never answers. The wait for a ready connection is bounded by `redisOptions.connectTimeout` (ioredis default 10000 ms), which until now covered only the TCP handshake; on expiry the call rejects with `RedisAdapter: connection not ready within N ms (redisOptions.connectTimeout)` and the half-open client is closed, so `bus.start()` fails instead of hanging. A server that needs longer than `connectTimeout` to become ready (a slow TLS or AUTH handshake) now fails to connect: raise `connectTimeout`, or set it to `0` to remove the deadline.

- [#630](https://github.com/Connectum-Framework/connectum/pull/630) [`d3c9f99`](https://github.com/Connectum-Framework/connectum/commit/d3c9f99e6f3a1ad214bf10001209c5956cca35a6) Thanks [@intech](https://github.com/intech)! - fix: a Redis consumer resumes after Redis loses its consumer group. After a restart without persistence, `FLUSHALL`, or a failover to a replica without the stream, the consume loop used to log `NOGROUP` every second and deliver nothing until the service restarted, while `publish()` kept succeeding. The adapter now re-creates the group on `NOGROUP` (from `XREADGROUP` and from the reclaim pass), reading from the beginning of the stream, so every entry Redis still retains is delivered (entries that `brokerOptions.maxLen` trimmed during the gap are gone); entries the group had already handled before the loss can be delivered a second time (at-least-once). A `console.warn` line is written and the new `group-recreated` lifecycle event (`group`, `stream`, `connection`) is delivered when `lifecycle.onLifecycle` is set; code with an exhaustive `switch` over `RedisLifecycleEvent` needs a branch for it.

- [#363](https://github.com/Connectum-Framework/connectum/pull/363) [`f635c79`](https://github.com/Connectum-Framework/connectum/commit/f635c79aedd1e89aeab1452bb4493bd3931d02f2) Thanks [@intech](https://github.com/intech)! - feat: `RedisAdapter` reports its connection lifecycle through `lifecycle.onLifecycle`, the same pattern as `@connectum/events-amqp`. Until now nothing told an operator that the Redis connection had dropped or that the client had given up.
  
  The events (a union on `type`, local to this package), each carrying `connection`: `"publisher"` for the publishing connection or `{ group, patterns }` for the dedicated blocking connection of one subscription. `connected { reconnected }` on a connection's first ready (`false`) and after every recovery (`true`); `disconnected { error }` once per loss of a connection that had been ready, however many reconnect attempts then fail; `reconnecting { attempt, delay, error }` for every scheduled attempt (the attempt counter restarts on ready); and the terminal `reconnect-failed { error }` when the client ends without the adapter closing it, which needs a `retryStrategy` that stops returning a delay. One loss of the server is reported once per connection, so an adapter with N subscriptions reports N+1 `disconnected` events. Nothing is reported before a connection's first ready (`connect()` rejects with the error itself) nor for the adapter's own `disconnect()` and `unsubscribe()`. A callback that throws or returns a rejected promise is isolated and reported once as `lifecycle-error`; a returned promise is not awaited.
  
  Without the option no listener is attached and nothing changes. With it, an `error` listener is attached to every connection, so the client's own `[ioredis] Unhandled error event` line on stderr is replaced by the cause carried in the events.

### Patch Changes

- [#427](https://github.com/Connectum-Framework/connectum/pull/427) [`6a3d1d3`](https://github.com/Connectum-Framework/connectum/commit/6a3d1d3204d95ef052b08e662fafaade61c7ab17) Thanks [@intech](https://github.com/intech)! - fix: a handler that is still running when `unsubscribe()` is called can now acknowledge its message. `EventBus.stop()` unsubscribes first and waits for the handlers afterwards, and both adapters tore down the acknowledgement path at that moment: `RedisAdapter` closed the blocking connection that also carried `XACK` (the acknowledgement failed with `Connection is closed.` and the entry stayed pending until it was reclaimed 30 seconds later), and `AmqpAdapter` closed the consumer channel (the acknowledgement was skipped, the broker took the message back and delivered it again to a consumer of the same group). The Redis adapter now acknowledges on its shared connection, which stays open until `disconnect()`; the AMQP adapter cancels the consumer at once but closes its channel when the last handler of that subscription has finished, without making `unsubscribe()` wait for a slow handler. Measured against a real Redis 6.2 and a real RabbitMQ 4.3.6 before the change (the acknowledgement error, the redelivery to a second consumer of a named group) and after it.

- [#317](https://github.com/Connectum-Framework/connectum/pull/317) [`d63985f`](https://github.com/Connectum-Framework/connectum/commit/d63985ffbd4014b5804e3dd73d3c58de39b16922) Thanks [@intech](https://github.com/intech)! - `RedisAdapter` no longer lets one failing entry block the redelivery of pending entries. When the handler threw on an entry claimed by `XAUTOCLAIM`, the rest of that batch was skipped (already claimed, so not eligible again for 30 s) and the failure was logged as `XAUTOCLAIM error (non-fatal)` without the entry id. Each reclaimed entry is now handled on its own: the failure is logged as `handler error for entry <entryId>`, the entry stays pending, and the remaining entries are delivered. The reclaim pass also continues from the `next-start-id` that `XAUTOCLAIM` returns instead of always starting at `0-0`, so stale entries behind more than `count * 10` recently delivered pending entries are reached. No option, event or default changes.

- [#651](https://github.com/Connectum-Framework/connectum/pull/651) [`70b91ca`](https://github.com/Connectum-Framework/connectum/commit/70b91caeffef5753cef81dccd1bfe2fdd7b50a93) Thanks [@intech](https://github.com/intech)! - fix: every package manifest now carries `homepage` (the package page on https://connectum.dev), `bugs.url` (the repository issue tracker) and one `repository` form (`git+https://github.com/Connectum-Framework/connectum.git` plus the package `directory`). Before, none of the 15 packages declared `homepage` or `bugs`, so the npm package page had no documentation or issue links and `npm docs` / `npm bugs` had nothing to open; the four events adapters also wrote `repository.url` without the `git+` prefix. The release gate now fails if any installed package differs from this form.

- [#325](https://github.com/Connectum-Framework/connectum/pull/325) [`3591014`](https://github.com/Connectum-Framework/connectum/commit/35910149aa614a388cfadbb11968b3deb57aad13) Thanks [@intech](https://github.com/intech)! - docs: the package READMEs are short entry points (install, a runnable start, constraints, links) and the long reference tables now live on the documentation site and in the API reference. The facts that exist only in a README stay there: the cancellation migration notes of `@connectum/interceptors`, the request initializer migration of `@connectum/protoc-gen-catalog`, the dependency injection and testing section of `@connectum/events`, the verified RabbitMQ and Kafka broker lines and the integration-suite instructions of the AMQP and Kafka adapters. Examples in the READMEs of eight packages and the Quickstart are executed against the packed packages by `pnpm docs:check`. JSDoc of a few exports was corrected to match the code; no runtime behavior changes.

- [#332](https://github.com/Connectum-Framework/connectum/pull/332) [`75588bd`](https://github.com/Connectum-Framework/connectum/commit/75588bdb286dff48ceb2d992aa0d27c28b2671e3) Thanks [@intech](https://github.com/intech)! - docs: the event adapters guide states that `*` and `>` patterns are rejected when the subscription is made (`RedisAdapter: wildcard pattern "..." is not supported. Redis Streams requires explicit topic names.`), and an integration test now pins that behaviour against a real broker.

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

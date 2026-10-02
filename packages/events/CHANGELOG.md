# @connectum/events

## 1.3.0

### Minor Changes

- [#223](https://github.com/Connectum-Framework/connectum/pull/223) [`774ef46`](https://github.com/Connectum-Framework/connectum/commit/774ef46e743ce528b554115553cddf19233bf52b) Thanks [@intech](https://github.com/intech)! - feat: named `EventAdapterFactory` type + official DI/testing guidance ([#204](https://github.com/Connectum-Framework/connectum/issues/204))
  
  - New exported `EventAdapterFactory` (`() => EventAdapter`) — the previously inline factory shape of `createBroadcastSubscribers`' `adapter` option, now a named public type (per-adapter named types are deliberately not added).
  - README gains a "Dependency Injection and Testing" section: the primary pattern is injecting an `EventAdapter` instance at the composition root (a configured test double does not fit a zero-argument factory without a wrapper); the factory is the secondary pattern for per-consumer connections (broadcast reactors). Test-double guidance: `MemoryAdapter` for the generic happy path; broker-specific failure semantics via the upcoming `@connectum/events-amqp/testing` fake ([#203](https://github.com/Connectum-Framework/connectum/issues/203)).
  - Types + docs only — zero runtime change.

- [#220](https://github.com/Connectum-Framework/connectum/pull/220) [`8962afa`](https://github.com/Connectum-Framework/connectum/commit/8962afa7d50cc67c1a385e0441a8ff00378871f6) Thanks [@intech](https://github.com/intech)! - feat: `drainPublishTimeout` — opt-in symmetric publish drain on shutdown ([#196](https://github.com/Connectum-Framework/connectum/issues/196))
  
  - New `EventBusOptions.drainPublishTimeout`: during `stop()`, wait up to the budget for in-flight `publish()` promises (started before `stop()`) to settle, before the adapter disconnects and would fail their confirms. Bus-level (L1): zero adapter-contract changes — nats/kafka/redis/amqp get the drain for free.
  - Runs concurrently with the handler drain (`drainTimeout`) — shutdown waits for the slower of the two budgets, never their sum.
  - Tracked promises carry a no-op observer: a publish settling (even rejecting) after the deadline never becomes an `unhandledRejection`; the caller's own `publish()` promise is unaffected.
  - Default `undefined` (and `0`/negative) — disabled: `stop()` behavior stays bit-for-bit (pinned by a regression test).
  - Documented limitation: publishes issued from draining handlers are not covered — the stopping gate rejects them (relay-pattern design tracked in [#212](https://github.com/Connectum-Framework/connectum/issues/212)).

- [#284](https://github.com/Connectum-Framework/connectum/pull/284) [`b85184a`](https://github.com/Connectum-Framework/connectum/commit/b85184a1b3cd61833e52c8c8aabd880ee4b1f85b) Thanks [@intech](https://github.com/intech)! - Generated code can import Connectum's option descriptors from the packages, and `connectum init` no longer generates its own copies.
  
  - `@connectum/auth` exports `./gen/connectum/auth/v1/options_pb.js` (`file_connectum_auth_v1_options`, `method_auth`, `service_auth`, the `MethodAuth` / `ServiceAuth` / `AuthRequirements` schemas and types), and `@connectum/events` exports `./gen/connectum/events/v1/options_pb.js` (`file_connectum_events_v1_options`, `event`, the `EventOptions` schema and type). Each subpath is the module the package itself uses, so a package evaluates its option proto once and hands out the same descriptor objects through every entry. Point protoc-gen-es (2.15.0 or later) at them with `map_imports=connectum/auth/v1/:@connectum/auth/gen` / `map_imports=connectum/events/v1/:@connectum/events/gen`. `@connectum/events` is now built with code splitting, so its `dist/index.js` imports a shared chunk.
  - `connectum init --auth` / `--events`: the generated `buf.gen.yaml` compiles Connectum's option protos without generating them (one `directory: proto` input, the vendored events option proto under `exclude_paths`) and maps their imports to the packages, so `gen/` no longer holds `connectum/{auth,events}/v1/options_pb.ts`. Every `@connectum/*` dependency of such a project is set to one range: the highest `@connectum/*` requirement of the fetched base, or `^1.3.0` if that is higher (also with `--ref`), so no base entry is lowered. Projects without auth or events are generated exactly as before. Existing projects keep working unchanged.

- [#282](https://github.com/Connectum-Framework/connectum/pull/282) [`36ce828`](https://github.com/Connectum-Framework/connectum/commit/36ce828cd36d84285e657b843b65ddbf28111107) Thanks [@intech](https://github.com/intech)! - feat: declare protobuf and Connect as peer dependencies, so an application runs with one copy of each
  
  `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` were regular dependencies. An application that pinned its own version could end up with a second copy that nothing reported: message and service types generated against one copy then stopped type-checking against the other, and a `connect-node` next to a different `connect` formed a pair `connect-node` does not support (it requires one exact `connect` version).
  
  - `@connectum/core`, `auth`, `events`, `healthcheck`, `interceptors`, `otel`, `reflection`, `testing` and `test-fixtures` now declare `@bufbuild/protobuf` `^2.16.0` and `@connectrpc/connect` `^2.2.0` in `peerDependencies`; `core` and `testing` also declare `@connectrpc/connect-node` `^2.2.0`.
  - `auth`, `events` and `interceptors` declare `@connectum/core` as a peer dependency instead of a dependency, so they use the application's own `@connectum/core`.
  - `@connectum/interceptors` now depends on `@bufbuild/protovalidate` directly. The validation interceptor imports it whether or not validation is enabled; it used to install only because npm, pnpm and Bun add missing peers of `@connectrpc/validate`.
  - `@connectum/cli` and `@connectum/protoc-gen-catalog` are unchanged: they are executables, and `@bufbuild/protoplugin` pins `@bufbuild/protobuf` exactly, so they keep their own copy and are outside the single-copy guarantee.
  
  With pins inside these ranges, or no pins at all, npm, pnpm and Bun now install exactly one copy of each library for the application and every Connectum runtime package. This includes `@connectum/reflection`, which now serves gRPC Server Reflection with Connectum's own implementation instead of a third-party library that kept its own protobuf / Connect copy.
  
  `createServer()` now checks the `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` that `@connectum/core` actually loaded against these ranges, and throws `PeerDependencyVersionError` (exported from `@connectum/core`) naming the package, the loaded version and its location, the required range and the fix. Lockstep is checked at startup too: the `@connectrpc/connect` that `@connectrpc/connect-node` itself loads must be the exact version connect-node declares, and the same copy `@connectum/core` loads. This makes an out-of-range version a visible startup failure on every package manager, including the ones that only warn at install time. When the version cannot be determined — `@connectum/core` bundled into the application, or a runtime without `import.meta.resolve` — the check is skipped rather than guessed.
  
  **BREAKING (installation and startup):** an install or a start that worked before can now fail.
  
  - npm refuses an application whose `@bufbuild/protobuf`, `@connectrpc/connect` or `@connectrpc/connect-node` pin is outside the ranges above, with `ERESOLVE unable to resolve dependency tree`. pnpm prints `Issues with peer dependencies found` (`pnpm peers check` names the library) and keeps the application's too-old copy; Bun warns in the same way, but stays silent about a too-old `@bufbuild/protobuf` when a code generator such as `protoc-gen-es` brings its own in-range copy. On pnpm and Bun the application then stops at `createServer()` with `PeerDependencyVersionError`.
  - Yarn does not install missing peer dependencies: Yarn users add `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` (and `@connectum/core` next to `auth`, `events` or `interceptors`) to their own `package.json`.
  
  Under strict Semantic Versioning this is a major change, and Connectum's breaking-changes strategy does not plan breaking changes for minor versions. It ships in 1.3.0 as an explicit, recorded exception, so that applications get the single-copy fix now rather than with 2.0.
  
  Migration: raise any pin of `@bufbuild/protobuf` to `^2.16.0` and of `@connectrpc/connect` / `@connectrpc/connect-node` to `^2.2.0`, keeping `connect` and `connect-node` on the same version — or remove the pins and let npm, pnpm or Bun install the peers. Do not work around a conflict with `--legacy-peer-deps` or `--force`: that reinstates the duplicate copies. Generate code with `protoc-gen-es` 2.16 or later.

### Patch Changes

- [#243](https://github.com/Connectum-Framework/connectum/pull/243) [`10a3e58`](https://github.com/Connectum-Framework/connectum/commit/10a3e584a1f8c6c80d96c533d88dc02300805289) Thanks [@intech](https://github.com/intech)! - Clear the remaining dependency advisories, and keep one `@bufbuild/protobuf` in the
  workspace.
  
  `@bufbuild/buf` moves to 1.72.0. `@bufbuild/protoplugin` now moves together with
  `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` under the single-instance pin: it
  had lagged one release behind and pinned a second copy of `@bufbuild/protobuf`, which
  is exactly the split the pin exists to prevent -- two instances break
  `@connectrpc/connect`'s protobuf peer and the reflection DTS build. The protobuf-es and
  connect-es versions this release requires are in the protobuf-es 2.16 / Connect 2.2
  entry.
  
  Several `overrides` were pinned to the version that closed an *earlier* advisory
  and had since been superseded: `brace-expansion` 5.0.5 -> 5.0.9, `js-yaml` 4.2.0 ->
  4.3.0 (plus a new pin for the 3.x line `@changesets/cli` pulls), `fast-uri` 3.1.2 ->
  3.1.5, `basic-ftp` 5.2.2 -> 5.3.1, `protobufjs` 7.6.3 -> 7.6.5, and new pins for
  `ip-address`, `linkify-it`, `undici` and `ws`. Every target is published and stays
  inside the major already installed.
  
  `pnpm audit` now reports no vulnerabilities at any severity, dev included; it
  previously reported 1 critical, 21 high and 14 moderate.

- [#214](https://github.com/Connectum-Framework/connectum/pull/214) [`e2b613b`](https://github.com/Connectum-Framework/connectum/commit/e2b613bad73024bf5b00c41717c063aac3665859) Thanks [@intech](https://github.com/intech)! - docs: recovery backoff tuning and publisher shutdown guidance
  
  - **events-amqp**: accurate reconnect-delay semantics in README and `AmqpRecoveryOptions` JSDoc — amqplib's strategy is symmetric jitter around the exponential base (not equal-jitter), and since amqplib 2.2.0 (the new minimum) the base is capped at `maxDelay / (1 + jitter)`, so a delay never exceeds `maxDelay`. Documented the exact full-jitter recipe: `jitter: 1`, `initialDelay: I/2`, `maxDelay: C` gives a delay uniform in `[0, min(I × factor^(n−1), C)]`.
  - **events**: new "Publishers and Shutdown" README section — `stop()` drains consumer handlers only; await-before-stop recipe for at-least-once producers; the stopping-gate limitation for publishes from draining handlers ([#212](https://github.com/Connectum-Framework/connectum/issues/212)); the planned opt-in `drainPublishTimeout` ([#196](https://github.com/Connectum-Framework/connectum/issues/196)).

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.2.0

## 1.1.0

### Minor Changes

- [#176](https://github.com/Connectum-Framework/connectum/pull/176) [`b5b3185`](https://github.com/Connectum-Framework/connectum/commit/b5b3185a3f745dc53686707fcabe069867df145a) Thanks [@intech](https://github.com/intech)! - Add `createBroadcastSubscribers` for first-class fan-out wiring, and make the duplicate-topic error actionable.

  Delivering one event to N independent reactors (each its own consumer group) requires one EventBus per reactor — the per-bus duplicate-topic guard forbids two routes on the same topic on one bus, and a shared group load-balances on a real broker instead of broadcasting. `createBroadcastSubscribers({ adapter, reactors })` builds that one-bus-per-reactor wiring (accepting a shared adapter or a per-bus factory) and rejects duplicate groups. The `Duplicate event topic` error now explains the fix (separate buses + distinct groups for independent reactors) instead of only suggesting a proto-option change.

- [#166](https://github.com/Connectum-Framework/connectum/pull/166) [`7876dcb`](https://github.com/Connectum-Framework/connectum/commit/7876dcb4e2c16c5988d50a58b7090b1bb6fd8b19) Thanks [@intech](https://github.com/intech)! - Add `EventBusOptions.publishes` for publisher-only processes. A process that publishes an event without subscribing to it had no `routes`, so `publish()` fell back to the message `typeName` and silently emitted to the wrong topic whenever the event declared a custom `(connectum.events.v1.event).topic`. List the event service descriptors in `publishes` to resolve the declared topic from the proto option end-to-end, instead of hand-maintaining raw topic strings.

- [#177](https://github.com/Connectum-Framework/connectum/pull/177) [`6e217df`](https://github.com/Connectum-Framework/connectum/commit/6e217dfb0c2080f8d306770dbd987827122633e1) Thanks [@intech](https://github.com/intech)! - Add an opt-in `EventBusOptions.strictTopics`. By default, when `publish()` finds no explicit `publishOptions.topic` and the event type is covered by neither `routes` nor `publishes`, it silently falls back to the raw message `typeName` — a silent misconfiguration that can emit to a topic no subscriber expects. With `strictTopics: true`, that unresolved-topic case throws at the call site instead. Default stays `false` (backward-compatible).

- [#186](https://github.com/Connectum-Framework/connectum/pull/186) [`ac41deb`](https://github.com/Connectum-Framework/connectum/commit/ac41deb0641ed4027b53fa7bc82a23312cfccdaa) Thanks [@intech](https://github.com/intech)! - Add `PublishOptions.messageId` and `PublishOptions.timestamp` (Unix epoch seconds) so a caller can set the message identity an external contract requires. Adapters honor them where supported and ignore them otherwise; `@connectum/events-amqp` maps them to the AMQP `messageId` / `timestamp` properties.

  This completes the external-contract publish path ([#161](https://github.com/Connectum-Framework/connectum/issues/161)): in `externalContract` mode the adapter auto-generates nothing, so a caller-supplied `messageId` / `timestamp` is the way to populate those wire properties when the contract demands them. A supplied value is used as-is in any mode; auto-generation still applies only in non-external mode when the caller omits them.

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

- Updated dependencies [[`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39), [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae)]:
  - @connectum/core@1.1.0

## 1.0.0

### Major Changes

- [#140](https://github.com/Connectum-Framework/connectum/pull/140) [`cd03cb3`](https://github.com/Connectum-Framework/connectum/commit/cd03cb35d66cc5109fc0853089ab659d30c73ccd) Thanks [@intech](https://github.com/intech)! - Remove `PublishOptions.sync`.

  The flag was a no-op: every adapter already confirms publishes per-message
  (NATS `PubAck`, Kafka `producer.send`, Redis `XADD`, AMQP per-message broker
  ack with typed errors on nack/return/timeout). A resolved `publish()` already
  means the broker accepted the message — there was no fire-and-forget mode to
  opt out of. Removed ahead of the first stable release; drop `sync` from any
  `publish()` calls (no behavior change).

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

- [#151](https://github.com/Connectum-Framework/connectum/pull/151) [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4) Thanks [@intech](https://github.com/intech)! - chore(deps): bump in-range production dependencies

  Raise the lower bounds of catalog-managed production dependencies within their
  existing `^` ranges (minor/patch, no breaking changes). On publish, pnpm rewrites
  each `catalog:` specifier to the concrete range, so raising the floor changes the
  dependency contract surfaced to consumers — hence a patch bump.

  - `@connectrpc/connect` `^2.1.1 → ^2.1.2`
  - `@connectrpc/connect-node` `^2.1.1 → ^2.1.2`
  - `@bufbuild/protobuf` `^2.11.0 → ^2.12.0`
  - `zod` `^4.3.6 → ^4.4.3`

  Affected packages (production `dependencies` referencing the above via `catalog:`):
  auth, cli, core, events, healthcheck, interceptors, otel, reflection,
  test-fixtures, testing. Build, typecheck, lint, unit/integration tests, the
  Bun/esbuild cross-runtime suites, and the HTTP ↔ in-process parity gate all pass
  with no behavioural changes (including ConnectRPC cancellation and unary-GET
  query handling paths).

  Dev-only tooling bumps in the same change (not part of the published dependency
  contract, so no version impact): `@biomejs/biome`, `@bufbuild/buf`,
  `@bufbuild/protoc-gen-es`, `@bufbuild/protovalidate`, `tsup`, `@types/node`.

- [#91](https://github.com/Connectum-Framework/connectum/pull/91) [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4) Thanks [@intech](https://github.com/intech)! - fix(events): preserve concrete input types in ServiceEventHandlers

  Changed `ServiceEventHandlers` mapped type to derive handler input types from
  `S["method"]` (concrete GenService record) instead of `S["methods"][number]`
  (generic DescMethod array). This preserves concrete protobuf message types
  in event handlers, eliminating the need for `as unknown as T` casts.

  Closes [#86](https://github.com/Connectum-Framework/connectum/issues/86)

- [#67](https://github.com/Connectum-Framework/connectum/pull/67) [`d42e2bd`](https://github.com/Connectum-Framework/connectum/commit/d42e2bdc7229635214abc63553b39d9dee8985b2) Thanks [@intech](https://github.com/intech)! - Fix composeMiddleware to support retry middleware

  The handler branch (dispatch terminal case) was outside the try/catch
  block, so handler errors did not reset the dispatch index. This caused
  retry middleware to hit the "next() called multiple times" guard on
  subsequent attempts instead of actually retrying.

  Moved handler into try/catch and added await for proper error propagation.

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06), [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2), [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302), [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837), [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.11

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

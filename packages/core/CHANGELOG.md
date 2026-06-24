# @connectum/core

## 1.1.0

### Minor Changes

- [#178](https://github.com/Connectum-Framework/connectum/pull/178) [`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39) Thanks [@intech](https://github.com/intech)! - Add `createCatalogClient({ catalog, resolver })` — a standalone, catalog-typed client usable OUTSIDE a `Server`. Out-of-process callers (a Temporal worker, a scheduler, a CLI) now get the same typed, resolver-routed `call` (unary) and `stream` (server/client/bidi) ergonomics as the in-handler `ctx.call`/`ctx.stream`, keyed off the generated `ConnectumCallMap`/`ConnectumStreamMap`, without constructing a `Server`.

  It resolves every target through the supplied `RemoteResolver` (`singleTransportResolver`/`mapResolver`/`dnsResolver`/`perServiceEnvResolver`) and dispatches over the returned `Transport`, caching the transport per `(typeName, endpoint)`. Because there is no in-process/local path, a service the resolver cannot resolve fails with `Code.Unavailable`; the rest of the error model mirrors `ctx.call` (`Unimplemented` for an unknown service/method, `Internal` when the resolver throws). Unlike `ctx.call`, `CallOptions` are applied verbatim — there is no inbound request, so the signal/deadline are not cascaded or clamped, no inbound headers are propagated, and no `ContextValues` are forwarded.

  Additive only: `ctx.call`/`ctx.stream`/`createServer` behavior and public types are unchanged.

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

## 1.0.0

### Major Changes

- [#141](https://github.com/Connectum-Framework/connectum/pull/141) [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302) Thanks [@intech](https://github.com/intech)! - **BREAKING** (behavioral): startup validation of bidi-streaming methods vs the effective transport.

  Per the Connect protocol, bidirectional streaming requires HTTP/2 — but the default `createServer()` transport without TLS is plaintext HTTP/1.1 (`allowHTTP1: true`). Previously a bidi service registered cleanly on that transport and failed silently at runtime: the first client send hung forever (or yielded HTTP 505). Now `server.start()` rejects with a `TransportValidationError` carrying the stable code `CONNECTUM_UNSUPPORTED_STREAMING_TRANSPORT`, the affected `service.method` list with streaming kinds, and both fixes (`allowHTTP1: false` for h2c, or TLS with ALPN). The rejected promise and the `error` event carry the same error object.

  New option:

  ```typescript
  createServer({
    // "error" (default) — fail fast at start()
    // "warn"  — log the diagnostic once and start anyway
    // "off"   — skip the check
    transportValidation: "error" | "warn" | "off",
  });
  ```

  Unary, server-streaming, and client-streaming methods are unaffected on any transport (the Connect protocol supports them over HTTP/1.1). A TLS server that also allows HTTP/1.1 (`allowHTTP1: true`) emits a one-time **warning** for bidi methods — never a hard error — because a client negotiating HTTP/1.1 over TLS hits the same hang; set `allowHTTP1: false` to refuse HTTP/1.1 at ALPN and remove the risk. A TLS or h2c server restricted to HTTP/2 never triggers the check.

  Deployments that knowingly ran bidi services on an HTTP/1.1-permitting config (they were broken at runtime) can downgrade with `transportValidation: "warn"` or `"off"`. Exported: `TransportValidationError`, `TRANSPORT_VALIDATION_ERROR_CODE`, `collectStreamingMethods`.

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

- [#152](https://github.com/Connectum-Framework/connectum/pull/152) [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837) Thanks [@intech](https://github.com/intech)! - feat(core)!: service catalog — declarative cross-service calls

  Adds the **service catalog** layer on top of the in-process transport: a
  standardized DX for calling other services (local or remote) without hand-rolling
  an endpoint registry, a transport cache, or per-call-site interceptor chains.

  New public API (additive):

  - **`defineService(descriptor, handlers)` / `defineLazyService(descriptor, factory)`** —
    the canonical way to register a service. They return a `ServiceDefinition`
    (`{ descriptor, register }`); `createServer({ services })` now takes
    `ServiceDefinition[]`. `defineLazyService` instantiates handlers only when the
    service is mounted locally. Handlers receive a Connectum `Context` (the
    ConnectRPC `HandlerContext` plus `ctx.call` / `ctx.stream`). An optional third
    `options` argument (`ServiceOptions`) forwards per-service handler options —
    e.g. service-scoped `interceptors` and `jsonOptions` — to `router.service()`,
    preserving the capability of the removed `ServiceRoute` form.
  - **`ctx.call(method, request, options?)`** — typed cross-service unary calls
    (`"${typeName}/${Method}"` keys). The framework routes in-process when the
    target is mounted locally and via the `remoteResolver` otherwise. The inbound
    `AbortSignal` and deadline cascade automatically (override via `CallOptions`;
    a caller may shorten the deadline, not extend it).
  - **`ctx.stream(method)`** — typed streaming calls: server-streaming yields an
    `AsyncIterable`; client- and bidi-streaming return push handles
    (`{ send, close }` / `{ send, close, responses }`).
  - **Catalog primitives** — `ServiceCatalog` type, `defineCatalog`, and
    `mergeCatalogs` (with a mandatory runtime duplicate-`typeName` guard), plus the
    `ConnectumCallMap` / `ConnectumStreamMap` module-augmentation targets that make
    `ctx.call` / `ctx.stream` type-safe (generated by `@connectum/protoc-gen-catalog`).
  - **`RemoteResolver`** type and built-in helpers `singleTransportResolver`,
    `mapResolver`, `dnsResolver`, `perServiceEnvResolver` — resolve a remote
    service to a `Transport` (synchronous, lazy, no startup network I/O).
  - **`enabledServices` helpers** — `parseServicesEnv`, `matchServicesPattern`,
    `mergeEnabledServices` for env-driven local activation (full proto typeNames),
    enabling one image to run as a monolith or as any single microservice role.
  - **`propagateHeaders`** — opt-in allow-list of inbound headers copied onto
    outgoing `ctx.call` / `ctx.stream` (empty by default; `defaultPropagateHeaders`
    exports the W3C trace-context set). `outgoingInterceptors` (a
    `@connectrpc/connect.Interceptor[]`) wrap outgoing catalog calls.
  - **`CatalogConfigError`** — a fail-loud configuration error (vs operational
    `ConnectError` codes) for catalog/resolver misconfiguration.

  **BREAKING** (pre-publish, lands before the first stable release): the legacy
  `ServiceRoute = (router) => void` registration form and the `server.client`
  `fallback` option are removed in favour of `defineService` and `remoteResolver`.
  Migrate `(router) => router.service(Desc, impl)` to `defineService(Desc, impl)`.

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

- [#128](https://github.com/Connectum-Framework/connectum/pull/128) [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180) Thanks [@intech](https://github.com/intech)! - feat(core): expose `jsonOptions` in `createServer()` to control Connect JSON serialization

  `CreateServerOptions` now accepts an optional `jsonOptions` field
  (`Partial<JsonReadOptions & JsonWriteOptions>`) that is threaded through to the
  underlying `connectNodeAdapter`. It applies server-wide, so it also covers
  protocol services registered by the framework (healthcheck, reflection).

  The most common use is emitting fields with implicit presence (proto3 scalar
  `0`, empty string/list, enum default) in JSON responses instead of omitting
  them:

  ```typescript
  const server = createServer({
    services: [routes],
    jsonOptions: { alwaysEmitImplicit: true },
  });
  ```

  For per-service control, the same option can still be passed as the third
  argument of `router.service()` inside a service route.

- [#8](https://github.com/Connectum-Framework/connectum/pull/8) [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e) Thanks [@intech](https://github.com/intech)! - Обновлены production-зависимости:

  **@connectum/otel** (minor):

  - OpenTelemetry SDK обновлён до v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
  - Resource class заменён на resourceFromAttributes()
  - LoggerProvider: processors передаются через constructor
  - MeterProvider: добавлен resource parameter

  **@connectum/core** (minor):

  - Zod обновлён с v3 до v4 (^4.3.6)
  - Изменён тип возврата safeParseEnvConfig (убрана явная аннотация z.SafeParseReturnType)

  **@connectum/cli** (patch):

  - citty обновлён до ^0.2.1
  - Исправлена типизация ProtoSyncOptions.template для exactOptionalPropertyTypes

  Также обновлены:

  - @biomejs/biome: ^1.9.4 → ^2.3.15 (конфиг автомигрирован)

- [#45](https://github.com/Connectum-Framework/connectum/pull/45) [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c) Thanks [@intech](https://github.com/intech)! - Add EventBus provider with pluggable broker adapters (NATS JetStream, Kafka/Redpanda, Redis Streams).

  **New packages:**

  - `@connectum/events` — Universal event adapter layer with proto-first pub/sub, middleware pipeline, DLQ
  - `@connectum/events-nats` — NATS JetStream adapter with durable consumers
  - `@connectum/events-kafka` — Kafka/Redpanda adapter with consumer groups
  - `@connectum/events-redis` — Redis Streams adapter with XREADGROUP

  **Core integration:**

  - `EventBusLike` interface for server lifecycle integration
  - `createServer({ eventBus })` option with automatic start/stop management

- [#117](https://github.com/Connectum-Framework/connectum/pull/117) [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e) Thanks [@intech](https://github.com/intech)! - Add in-process transport with automatic local/remote routing via service registry.

  **`@connectum/core`** — new public API for in-process service invocation:

  - `createLocalTransport(server, options?)` — ConnectRPC `Transport` bound to the server's router; supports client-side interceptors.
  - `server.client(service, options?)` — auto-routing client factory: in-process if `service` is registered on this server, else `options.fallback`, else fail-fast `ConnectError(unimplemented)`.
  - `server.localClient(service)` — low-level helper that always returns an in-process client.
  - `server.hasService(desc)` — synchronous service registry lookup by `desc.typeName`.

  The in-process transport runs the full server-side interceptor chain (validation, authorization, OpenTelemetry), supports unary and all streaming RPCs, propagates `Headers` and `AbortSignal`, and preserves 1-to-1 behavioural parity with the HTTP/gRPC transport. Strictly additive — no breaking changes.

  **`@connectum/testing`** — helpers for cross-transport testing:

  - `createLocalClient(server, service)` — concise client for unit and integration tests without binding ports.
  - `transportParityTest(name, scenario)` — driver that runs one declarative scenario against both `createGrpcTransport` and `createLocalTransport`, structurally diffs the observable outcome (response, headers, `ConnectError`, OTEL spans, metrics), and fails on any divergence.
  - In-memory OTEL `SpanExporter` and `MetricReader` collectors used by the parity driver.

  **`@connectum/otel`** — observability parity for the in-process path:

  - `connectum.transport` span attribute (`in-process` | `http`) on both CLIENT and SERVER spans.
  - `transport` metric label on `rpc.client.duration`, `rpc.server.duration`, payload size, and error counter instruments.
  - W3C Trace Context (`traceparent` / `tracestate`) propagation through in-memory `Headers` so server spans are children of client spans on both transports.

- [#31](https://github.com/Connectum-Framework/connectum/pull/31) [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95) Thanks [@intech](https://github.com/intech)! - Three transport modes: TLS (createSecureServer), h2c (http2.createServer), HTTP/1.1 (http.createServer).

  New exported types: `TransportServer`, `NodeRequest`, `NodeResponse`.

  `allowHTTP1` option now selects transport mode without TLS: `true` (default) uses HTTP/1.1, `false` uses h2c.

### Patch Changes

- [#13](https://github.com/Connectum-Framework/connectum/pull/13) [`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06) Thanks [@intech](https://github.com/intech)! - CI/CD and documentation improvements

  **CI/CD:**

  - Switch to OIDC trusted publishers (no NPM_TOKEN)
  - Add PR snapshot publishing via pkg-pr-new
  - Fix provenance: use NPM_CONFIG_PROVENANCE env var instead of CLI argument

  **Docs:**

  - Fix healthcheck README: clarify Check/Watch (standard) + List (extension), license MIT → Apache-2.0
  - Fix httpHandler.ts JSDoc: HTTP_HEALTH_ENABLED → HealthcheckOptions.httpEnabled
  - Add comprehensive reflection README (API, grpcurl, buf curl usage)

- [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2) Thanks [@intech](https://github.com/intech)! - Code review: critical fixes, ServerImpl decomposition, HealthcheckManager factory, unit tests

  **core:**

  - Fix Promise.race error swallowing in graceful shutdown
  - Fix error listener leak on synchronous throw in listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only in watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy in HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers in fallback response
  - Improve bulkhead error message
  - Consistent await in serializer
  - Fix double type cast in errorHandler

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

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add cross-runtime test scripts (`test:bun`, `test:esbuild`) to all packages via `@exodus/test`. Packages with known incompatibilities (interceptors/bun, otel/bun, cli/bun) gracefully skip. Root `test:cross-runtime` runs all runtimes via turbo.

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

- [#156](https://github.com/Connectum-Framework/connectum/pull/156) [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4) Thanks [@intech](https://github.com/intech)! - fix: re-export `EffectiveTransport` and `TransportValidationMode` as values from the package root

  These are ADR-001 const-object enums — they carry both a runtime value and a type. They were re-exported from the barrel with `export type { … }`, which erased the runtime const: consumers got `undefined` (e.g. `TransportValidationMode.ERROR`, `EffectiveTransport.TLS_H2_ONLY`) while the generated `.d.ts` still advertised them as usable values, so calls type-checked and then crashed (or compared always-false against `resolveEffectiveTransport()`). They are now re-exported as values, carrying both the const and the type.

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

## 1.0.0-rc.11

## 1.0.0-rc.10

## 1.0.0-rc.9

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

## 1.0.0-rc.7

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

## 1.0.0-rc.5

### Minor Changes

- [#31](https://github.com/Connectum-Framework/connectum/pull/31) [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95) Thanks [@intech](https://github.com/intech)! - Three transport modes: TLS (createSecureServer), h2c (http2.createServer), HTTP/1.1 (http.createServer).

  New exported types: `TransportServer`, `NodeRequest`, `NodeResponse`.

  `allowHTTP1` option now selects transport mode without TLS: `true` (default) uses HTTP/1.1, `false` uses h2c.

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add cross-runtime test scripts (`test:bun`, `test:esbuild`) to all packages via `@exodus/test`. Packages with known incompatibilities (interceptors/bun, otel/bun, cli/bun) gracefully skip. Root `test:cross-runtime` runs all runtimes via turbo.

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

## 1.0.0-rc.3

### Patch Changes

- [#13](https://github.com/Connectum-Framework/connectum/pull/13) [`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06) Thanks [@intech](https://github.com/intech)! - CI/CD and documentation improvements

  **CI/CD:**

  - Switch to OIDC trusted publishers (no NPM_TOKEN)
  - Add PR snapshot publishing via pkg-pr-new
  - Fix provenance: use NPM_CONFIG_PROVENANCE env var instead of CLI argument

  **Docs:**

  - Fix healthcheck README: clarify Check/Watch (standard) + List (extension), license MIT → Apache-2.0
  - Fix httpHandler.ts JSDoc: HTTP_HEALTH_ENABLED → HealthcheckOptions.httpEnabled
  - Add comprehensive reflection README (API, grpcurl, buf curl usage)

## 1.0.0-rc.2

### Minor Changes

- [#8](https://github.com/Connectum-Framework/connectum/pull/8) [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e) Thanks [@intech](https://github.com/intech)! - Updated production dependencies:

  **@connectum/otel** (minor):

  - OpenTelemetry SDK updated to v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
  - Resource class replaced with resourceFromAttributes()
  - LoggerProvider: processors are now passed via the constructor
  - MeterProvider: added resource parameter

  **@connectum/core** (minor):

  - Zod updated from v3 to v4 (^4.3.6)
  - Changed safeParseEnvConfig return type (removed explicit z.SafeParseReturnType annotation)

  **@connectum/cli** (patch):

  - citty updated to ^0.2.1
  - Fixed ProtoSyncOptions.template typing for exactOptionalPropertyTypes

  Also updated:

  - @biomejs/biome: ^1.9.4 → ^2.3.15 (config auto-migrated)

## 1.0.0-beta.2

### Minor Changes

- 4e784c1: refactor: removed @connectum/utilities package

  **BREAKING**: The `@connectum/utilities` package has been completely removed from the monorepo.

  Reasons for removal:

  - 0 real consumers — no package imported utilities
  - All functions had better alternatives (Node.js built-ins or battle-tested npm packages)
  - 2 critical bugs: timer leak in withTimeout, broken LRU cache (FIFO instead of LRU)
  - 6 out of 9 modules without tests

  Replacement table:

  - `retry()` → `cockatiel` (already in the project)
  - `sleep()` → `import { setTimeout } from 'node:timers/promises'`
  - `withTimeout()` → `AbortSignal.timeout(ms)` (Node.js built-in)
  - `LRUCache` → `lru-cache` npm
  - `safeStringify()` → `safe-stable-stringify` npm
  - `Observable` → `EventEmitter` from `node:events`
  - `Monitor` → `events.on()` from `node:events`

  Relocations:

  - `ConnectumEnvSchema`, `parseEnvConfig`, `safeParseEnvConfig` → `@connectum/core/config`

  Other changes:

  - `@connectum/otel`: removed phantom dependency on utilities (was not used)

### Patch Changes

- Code review: critical fixes, ServerImpl decomposition, HealthcheckManager factory, unit tests

  **core:**

  - Fix Promise.race error swallowing in graceful shutdown
  - Fix error listener leak on synchronous throw in listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only in watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy in HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers in fallback response
  - Improve bulkhead error message
  - Consistent await in serializer
  - Fix double type cast in errorHandler

- Updated dependencies
  - @connectum/interceptors@1.0.0-beta.2

## 0.2.0-beta.1

### Minor Changes

- feat: 5-phase graceful shutdown with `shutdownSignal` and `ShutdownManager` with dependency-ordered hooks
- feat: `builtinInterceptors` option — custom interceptors append after builtins

### Patch Changes

- refactor!: uniform registration API, remove deprecated code
- refactor: update healthcheck references (`withHealthcheck` -> `Healthcheck`)
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.

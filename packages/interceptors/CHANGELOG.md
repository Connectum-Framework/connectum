# @connectum/interceptors

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.2.0

## 1.1.0

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

- Updated dependencies [[`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39), [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae)]:
  - @connectum/core@1.1.0

## 1.0.0

### Major Changes

- [#138](https://github.com/Connectum-Framework/connectum/pull/138) [`748b804`](https://github.com/Connectum-Framework/connectum/commit/748b804da89bbdd179bfdbb389cd4d2efc79d06a) Thanks [@intech](https://github.com/intech)! - **BREAKING** (behavioral, ×2): explicit-over-hidden resilience defaults and infrastructure-only circuit breaker classification.

  1. **`createDefaultInterceptors()` no longer enables resilience interceptors implicitly.** `timeout`, `bulkhead`, `circuitBreaker`, and `retry` now default to disabled; only `errorHandler` and `validation` remain enabled by default. Hidden behavioral logic is unacceptable — enable each interceptor explicitly:

     ```typescript
     // Before (implicit): createDefaultInterceptors()
     // After (explicit):
     createDefaultInterceptors({
       timeout: true,
       bulkhead: true,
       circuitBreaker: true,
       retry: true,
     });
     ```

  2. **Circuit breaker now classifies errors.** Only infrastructure codes trip the breaker by default (`unknown`, `deadline_exceeded`, `internal`, `unavailable`, `data_loss`, `resource_exhausted`, plus non-`ConnectError` values). Business codes (`invalid_argument`, `not_found`, `failed_precondition`, `already_exists`, ...) no longer open the circuit, and in half-open state they close it. New `failurePredicate(error, defaultPredicate)` option composes with or replaces the default policy; `defaultFailurePredicate` is exported. Restore legacy all-errors counting with:

     ```typescript
     createCircuitBreakerInterceptor({ failurePredicate: () => true });
     ```

  The circuit breaker is repositioned in the docs as an outbound/client-transport pattern; for inbound protection prefer explicit `timeout` + `bulkhead`. Guaranteed ordering: the breaker wraps retry, so one logical request increments the failure counter at most once.

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

- [#77](https://github.com/Connectum-Framework/connectum/pull/77) [`6d8a763`](https://github.com/Connectum-Framework/connectum/commit/6d8a763ae6d22b0a065be21dbada5521ba526145) Thanks [@intech](https://github.com/intech)! - **BREAKING**: Serializer interceptor is now disabled by default in `createDefaultInterceptors()`.

  Previously enabled automatically (opt-out via `serializer: false`), now requires explicit opt-in via `serializer: true` or `serializer: { ... }`.

  **Migration**: Add `serializer: true` to `createDefaultInterceptors()` if JSON serialization is needed:

  ```typescript
  // Before (serializer was auto-enabled)
  createDefaultInterceptors();

  // After — if you need JSON serialization
  createDefaultInterceptors({ serializer: true });
  ```

  Thanks to @jusandi for identifying the issue with implicit JSON serialization causing problems in streaming between microservices.

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#144](https://github.com/Connectum-Framework/connectum/pull/144) [`06923a9`](https://github.com/Connectum-Framework/connectum/commit/06923a9003e2778ad2a91188829e7dca27096871) Thanks [@intech](https://github.com/intech)! - Bump `cockatiel` to `4.0.0`.

  `cockatiel` 4.0.0 is ESM-only and raises its minimum Node.js to 22 (aligned with
  the framework's `>=22.13.0` floor). The circuit-breaker interceptor remains
  behaviorally identical: the policy executor still invokes the error filter
  without guarding it (so the mandatory fail-closed `try/catch` around the failure
  predicate is retained), and predicate-rejected errors are still rethrown as
  unhandled — they do not increment the breaker and, in half-open, close the
  circuit. Verified against the 4.0.0 sources; the full interceptors test suite
  (158 tests) passes unchanged.

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

- [#117](https://github.com/Connectum-Framework/connectum/pull/117) [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e) Thanks [@intech](https://github.com/intech)! - Extract mock factories, assertion helpers, and protobuf descriptor fixtures
  from `@connectum/testing` into a new transport-free package
  `@connectum/test-fixtures`.

  **Why**: `@connectum/interceptors` depended on `@connectum/testing` in
  devDependencies for its unit tests (via `assertConnectError`, `createMockNext*`,
  `createMockRequest`), while `@connectum/testing` depended on
  `@connectum/interceptors` for parity tests — creating a workspace build cycle
  that broke `turbo build` and forced `pack-all.sh` to fall back to
  `pnpm -r --workspace-concurrency=1`.

  **What moved** (from `@connectum/testing` → `@connectum/test-fixtures`):

  - `assertConnectError`
  - `createMockFn`, `MockCall`, `MockFn`
  - `createMockRequest`, `createMockNext`, `createMockNextError`, `createMockNextSlow`
  - `createMockStream`
  - `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`
  - `createFakeService`, `createFakeMethod`
  - All mock/fixture option types (`MockRequestOptions`, `MockNextOptions`, etc.)

  **Backwards compatible**: all the above symbols are re-exported from
  `@connectum/testing` so existing imports continue to work unchanged. The
  parity driver, in-process transport helper, test server, and OTel collectors
  remain in `@connectum/testing`.

  **Internal**: `@connectum/interceptors` now depends on
  `@connectum/test-fixtures` in devDependencies instead of `@connectum/testing`.
  Its public API is unchanged.

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06), [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2), [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302), [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837), [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.9

## 1.0.0-rc.8

### Major Changes

- [#77](https://github.com/Connectum-Framework/connectum/pull/77) [`6d8a763`](https://github.com/Connectum-Framework/connectum/commit/6d8a763ae6d22b0a065be21dbada5521ba526145) Thanks [@intech](https://github.com/intech)! - **BREAKING**: Serializer interceptor is now disabled by default in `createDefaultInterceptors()`.

  Previously enabled automatically (opt-out via `serializer: false`), now requires explicit opt-in via `serializer: true` or `serializer: { ... }`.

  **Migration**: Add `serializer: true` to `createDefaultInterceptors()` if JSON serialization is needed:

  ```typescript
  // Before (serializer was auto-enabled)
  createDefaultInterceptors();

  // After — if you need JSON serialization
  createDefaultInterceptors({ serializer: true });
  ```

  Thanks to @jusandi for identifying the issue with implicit JSON serialization causing problems in streaming between microservices.

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

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda)]:
  - @connectum/core@1.0.0-rc.8

## 1.0.0-rc.7

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.7

## 1.0.0-rc.6

### Patch Changes

- Updated dependencies [[`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c)]:
  - @connectum/core@1.0.0-rc.6

## 1.0.0-rc.5

### Patch Changes

- Updated dependencies [[`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

- Updated dependencies [[`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177)]:
  - @connectum/core@1.0.0-rc.4

## 1.0.0-rc.3

## 1.0.0-rc.2

## 1.0.0-beta.2

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

## 0.2.0-beta.1

### Minor Changes

- feat: `createMethodFilterInterceptor` (ADR-014) — per-service/per-method routing

### Patch Changes

- refactor!: production-ready default chain with resilience patterns (`errorHandler` -> `timeout` -> `bulkhead` -> `circuitBreaker` -> `retry` -> `fallback` -> `validation` -> `serializer`)
- refactor: retry switched to cockatiel (exponential backoff)
- refactor: remove domain-specific interceptors (`redact`, `addToken`, `validation` -> `@connectrpc/validate`)
- refactor: remove 30 biome-ignore directives, replace `any` with explicit types
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.

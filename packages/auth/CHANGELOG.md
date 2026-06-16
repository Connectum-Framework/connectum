# @connectum/auth

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

- [#30](https://github.com/Connectum-Framework/connectum/pull/30) [`745619d`](https://github.com/Connectum-Framework/connectum/commit/745619d718e915e381293ba71c231e691eae0208) Thanks [@intech](https://github.com/intech)! - Proto-based authorization via custom options in `.proto` files.

  New `createProtoAuthzInterceptor()` — authorization based on proto options.
  Proto reader for extracting auth options from DescFile.
  Fix: lazy auth context in proto-authz interceptor.
  tsup splitting enabled.

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add gateway, session interceptors, LRU cache, and security hardening (v2).

  **New interceptors:**

  - `createGatewayAuthInterceptor()` — extract auth context from trusted gateway headers (replaces dead code `createTrustedHeadersReader`)
  - `createSessionAuthInterceptor()` — convenience wrapper for session/cookie-based auth (better-auth, lucia, etc.) with LRU caching

  **LRU cache:**

  - `LruCache<T>` — minimal in-memory cache with TTL + max-size eviction
  - Opt-in via `cache: { ttl, maxSize }` in session and generic auth interceptors

  **Security fixes:**

  - SEC-001: `propagatedClaims` filter prevents PII leak in header propagation
  - SEC-002: reject JWT without `sub` claim (previously fell back to "unknown")
  - SEC-005: sanitize `subject` and `type` header values

  **Header propagation:**

  - `AUTH_HEADERS.NAME` added for name propagation
  - `setAuthHeaders` / `parseAuthHeaders` support name field

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

- [#92](https://github.com/Connectum-Framework/connectum/pull/92) [`4800ce8`](https://github.com/Connectum-Framework/connectum/commit/4800ce8ed8f063680b2d6e3def9d4f59bd2a8217) Thanks [@intech](https://github.com/intech)! - feat(auth): add client-side auth interceptors (bearer, gateway)

  Added two client interceptor factories:

  - `createClientBearerInterceptor()` — sets Authorization header with static or async token
  - `createClientGatewayInterceptor()` — sets gateway secret and auth context headers for service-to-service communication

- [#26](https://github.com/Connectum-Framework/connectum/pull/26) [`e209b5c`](https://github.com/Connectum-Framework/connectum/commit/e209b5cac4f0f8eabb6e88d9d80389917ac5d47e) Thanks [@intech](https://github.com/intech)! - Change JWT key resolution priority from `jwksUri > secret > publicKey` to `jwksUri > publicKey > secret`.

  Asymmetric keys are cryptographically stronger than symmetric secrets, so `publicKey` now takes precedence over `secret` when both are provided. Also improved `publicKey` JSDoc with supported algorithms (RSA, RSA-PSS, EC, EdDSA) and `crypto.subtle.importKey()` examples.

### Patch Changes

- [#78](https://github.com/Connectum-Framework/connectum/pull/78) [`913cafe`](https://github.com/Connectum-Framework/connectum/commit/913cafeb34cdac8d988ee592aca3cd31d3543f69) Thanks [@intech](https://github.com/intech)! - fix(auth): make authContextStorage resilient to multiple module evaluations

  Uses globalThis + Symbol.for() to ensure a single AsyncLocalStorage instance
  per process, even when the module is evaluated through multiple runtime paths
  (e.g., tsx source + built workspace output in dev).

  Emits a one-time `CONNECTUM_AUTH_DUP_INIT` warning when dual initialization
  is detected, helping diagnose mixed src/dist import issues.

  Fixes [#75](https://github.com/Connectum-Framework/connectum/issues/75). Thanks to @kebr0m for the detailed bug report and root cause analysis.

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

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06), [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2), [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302), [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837), [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.11

## 1.0.0-rc.10

### Minor Changes

- [#92](https://github.com/Connectum-Framework/connectum/pull/92) [`4800ce8`](https://github.com/Connectum-Framework/connectum/commit/4800ce8ed8f063680b2d6e3def9d4f59bd2a8217) Thanks [@intech](https://github.com/intech)! - feat(auth): add client-side auth interceptors (bearer, gateway)

  Added two client interceptor factories:

  - `createClientBearerInterceptor()` — sets Authorization header with static or async token
  - `createClientGatewayInterceptor()` — sets gateway secret and auth context headers for service-to-service communication

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- [#78](https://github.com/Connectum-Framework/connectum/pull/78) [`913cafe`](https://github.com/Connectum-Framework/connectum/commit/913cafeb34cdac8d988ee592aca3cd31d3543f69) Thanks [@intech](https://github.com/intech)! - fix(auth): make authContextStorage resilient to multiple module evaluations

  Uses globalThis + Symbol.for() to ensure a single AsyncLocalStorage instance
  per process, even when the module is evaluated through multiple runtime paths
  (e.g., tsx source + built workspace output in dev).

  Emits a one-time `CONNECTUM_AUTH_DUP_INIT` warning when dual initialization
  is detected, helping diagnose mixed src/dist import issues.

  Fixes [#75](https://github.com/Connectum-Framework/connectum/issues/75). Thanks to @kebr0m for the detailed bug report and root cause analysis.

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

### Minor Changes

- [#30](https://github.com/Connectum-Framework/connectum/pull/30) [`745619d`](https://github.com/Connectum-Framework/connectum/commit/745619d718e915e381293ba71c231e691eae0208) Thanks [@intech](https://github.com/intech)! - Proto-based authorization via custom options in `.proto` files.

  New `createProtoAuthzInterceptor()` — authorization based on proto options.
  Proto reader for extracting auth options from DescFile.
  Fix: lazy auth context in proto-authz interceptor.
  tsup splitting enabled.

- [#26](https://github.com/Connectum-Framework/connectum/pull/26) [`e209b5c`](https://github.com/Connectum-Framework/connectum/commit/e209b5cac4f0f8eabb6e88d9d80389917ac5d47e) Thanks [@intech](https://github.com/intech)! - Change JWT key resolution priority from `jwksUri > secret > publicKey` to `jwksUri > publicKey > secret`.

  Asymmetric keys are cryptographically stronger than symmetric secrets, so `publicKey` now takes precedence over `secret` when both are provided. Also improved `publicKey` JSDoc with supported algorithms (RSA, RSA-PSS, EC, EdDSA) and `crypto.subtle.importKey()` examples.

### Patch Changes

- Updated dependencies [[`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add gateway, session interceptors, LRU cache, and security hardening (v2).

  **New interceptors:**

  - `createGatewayAuthInterceptor()` — extract auth context from trusted gateway headers (replaces dead code `createTrustedHeadersReader`)
  - `createSessionAuthInterceptor()` — convenience wrapper for session/cookie-based auth (better-auth, lucia, etc.) with LRU caching

  **LRU cache:**

  - `LruCache<T>` — minimal in-memory cache with TTL + max-size eviction
  - Opt-in via `cache: { ttl, maxSize }` in session and generic auth interceptors

  **Security fixes:**

  - SEC-001: `propagatedClaims` filter prevents PII leak in header propagation
  - SEC-002: reject JWT without `sub` claim (previously fell back to "unknown")
  - SEC-005: sanitize `subject` and `type` header values

  **Header propagation:**

  - `AUTH_HEADERS.NAME` added for name propagation
  - `setAuthHeaders` / `parseAuthHeaders` support name field

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

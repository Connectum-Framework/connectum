# @connectum/auth

## 1.3.0

### Minor Changes

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

- [#254](https://github.com/Connectum-Framework/connectum/pull/254) [`d9f9fb4`](https://github.com/Connectum-Framework/connectum/commit/d9f9fb4f3360a906a0404a0feeda45d026a5cadd) Thanks [@intech](https://github.com/intech)! - Add configurable RESP2 and RESP3 Redis Streams support while preserving RESP2 as the backward-compatible default, and refresh the Redis, AMQP testcontainer, and authentication dependencies.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.2.0

## 1.1.0

### Minor Changes

- [#179](https://github.com/Connectum-Framework/connectum/pull/179) [`3ecb55f`](https://github.com/Connectum-Framework/connectum/commit/3ecb55f2969e55224f0b47338da8237d1b82c48a) Thanks [@intech](https://github.com/intech)! - Add a first-class `internal` (service-to-service) auth marker and interceptor (ADR-029), distinct from `public`. An `internal` method skips end-user (JWT) authentication but **requires an internal trust marker** — so promoting a method `public → internal` removes world-open exposure instead of merely renaming it, and the contract now audits as "internal" rather than "public".

  - **Proto:** `optional bool internal` added to `ServiceAuth` and `MethodAuth` (`connectum/auth/v1/options.proto`, additive). `resolveMethodAuth` surfaces `internal` with the same method-overrides-service precedence as `public`.
  - **`createInternalAuthInterceptor`** — for `internal` methods, authorizes via a pluggable per-service **trust source** (`(req) => AuthContext | null`) and rejects a missing/invalid marker as `Code.Unauthenticated`; non-`internal` methods are a no-op pass-through. Three trust-source factories ship:
    - **`meshIdentityTrust({ allowlist, header? })`** — production default; verify a mesh-forwarded peer principal (Istio short-form ServiceAccount / SPIFFE id) against an allow-list carrying roles/scopes. Per-service by construction (the mesh issues each workload its own identity). The identity header is stripped after extraction (anti-spoofing).
    - **`signedTokenTrust({ issuers, header? })`** — non-mesh per-service containment via per-service JWT/JWKS. **The JWKS lookup is issuer-bound**: the keyset is selected by the token's `iss` claim (`issuers[iss].jwksUri`, one `createRemoteJWKSet` per issuer) and verification is pinned to that same issuer. A single shared JWKS across issuers does NOT contain compromise (jose resolves the signing key by `kid` independently of `iss`), so a token claiming `iss: B` signed with A's key is rejected.
    - **`sharedSecretTrust({ secret, header? })`** — **dev-only** fallback (single shared secret, constant-time compared). NOT per-service — one compromise forges all callers — and documented as such.
  - **`getInternalMethods(services)`** — mirrors `getPublicMethods`; feed both into the JWT interceptor's `skipMethods`.
  - **`createProtoAuthzInterceptor`** composes `internal` inclusively within its existing flow (one model, no parallel `requires_identity`): `internal` + identity + no `requires` → allow; `internal` + `requires {roles/scopes}` → the existing roles/scopes check against the internal identity; `internal` + no identity → `Unauthenticated`. The internal/JWT interceptors MUST run before `createProtoAuthzInterceptor` (they populate the `AuthContext` it consumes): `errorHandler → (jwtAuth | internalAuth) → protoAuthz`.

  Purely additive — existing `public` and gated behavior are unchanged.

- [#175](https://github.com/Connectum-Framework/connectum/pull/175) [`c51bc7e`](https://github.com/Connectum-Framework/connectum/commit/c51bc7ef6391bb908435eb933e98d4b3a94b9eff) Thanks [@intech](https://github.com/intech)! - Add RS256 + JWKS test helpers to `@connectum/auth/testing`. The existing `createTestJwt` is HS256-only, but the production-realistic path with an external IdP is RS256 validated through a JWKS endpoint (`createJwtAuthInterceptor({ jwksUri })`). The new `generateRsaTestKeypair()`, `startTestJwksServer()`, and `createTestJwtRS256()` let you test that path without hand-rolling a keypair + JWKS server + minter — the minted token is verified through the same `createRemoteJWKSet` branch production uses.

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

- Updated dependencies [[`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39), [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae)]:
  - @connectum/core@1.1.0

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

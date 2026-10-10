# @connectum/interceptors

## 1.3.0

### Minor Changes

- [#320](https://github.com/Connectum-Framework/connectum/pull/320) [`7243ba4`](https://github.com/Connectum-Framework/connectum/commit/7243ba49a4784e2b5c6d283607c086e5f360ed6e) Thanks [@intech](https://github.com/intech)! - feat!: the logger interceptor no longer logs request and response bodies unless `includeBodies: true` is set
  
  **BREAKING.** `createLoggerInterceptor` used to hand the request and response message of every call (and the JSON form of every streamed response message) to the log sink. Bodies carry credentials, tokens and personal data, so they are now off by default. The log lines keep their text (`RPC <path> request`, `RPC <path> response`, `STREAM <path> request|response`, completion, failure); only the extra body argument is gone, and streamed response messages are no longer converted to JSON when bodies are off.
  
  To get the previous output, set the new option:
  
  ```typescript
  createLoggerInterceptor({ includeBodies: true });
  ```
  
  See the migration guide for details.

- [#272](https://github.com/Connectum-Framework/connectum/pull/272) [`0d98fbd`](https://github.com/Connectum-Framework/connectum/commit/0d98fbd1dd304a362d446996c5d433bea7ffb664) Thanks [@intech](https://github.com/intech)! - feat: opt-in `includeTransport` on `createLoggerInterceptor`
  
  With `includeTransport: true` every log line of a call is tagged with the
  transport that carried it, right after the `RPC` / `STREAM` prefix:
  `[in-process]` for calls made through `server.localClient()` /
  `createLocalTransport()` of `@connectum/core`, `[http]` for every other call.
  A forged in-process marker on an inbound HTTP request is stripped by the
  server, so such a call is still logged as `[http]`.
  
  The tag is telemetry only — do not base authorization or other security
  decisions on it; use `req.service.typeName` and `req.method.name`.
  
  Off by default: without the option the log lines are unchanged.

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

- [#330](https://github.com/Connectum-Framework/connectum/pull/330) [`7f5317a`](https://github.com/Connectum-Framework/connectum/commit/7f5317a80c262048acefbb3eb3562704b4c95d3d) Thanks [@intech](https://github.com/intech)! - fix!: timeout now cancels downstream work and retry stops on cancellation, so a timed-out or cancelled call no longer retries or returns a late success
  
  **Behaviour change.** Before, the timeout interceptor only stopped the caller from waiting: the downstream chain and the handler received no signal and kept running, and retry could start another attempt or return a late success after the caller had already been told the call failed. Now:
  
  - When the timeout expires, `req.signal` (and `ctx.signal` in the handler) is aborted with a `DeadlineExceeded` `ConnectError` ("Request timeout after Nms"). Caller cancellation is forwarded the same way. The first cancellation cause decides the error: an existing caller `ConnectError` keeps its code, message, metadata and details; any other caller reason becomes `Canceled`.
  - Retry interrupts a pending backoff, never starts another attempt after cancellation, and turns a late success of cancelled work into a cancellation error. Retry still waits for a running signal-unaware handler to settle, so a surrounding bulkhead keeps counting that work as active.
  - Code that relied on a late successful response, or on one more retry after a timeout or cancellation, now receives `DeadlineExceeded` or `Canceled`. Handlers and I/O must observe the signal to stop work; cancellation does not roll back side effects of code that ignores it.
  
  **Timeout and circuit breaker.** With the default order (`timeout` outside `circuitBreaker`, which wraps `retry`), an expired timeout now reaches the breaker as a `DeadlineExceeded` failure, and `DeadlineExceeded` is one of the codes the default failure predicate counts. Repeated timeouts of a cooperative handler therefore open the circuit; before, the breaker never saw the timeout and only saw whatever the abandoned handler eventually returned. For a handler that ignores the signal, the failure is recorded when that handler settles (not when the caller gets its deadline error), and only because `retry` turns the late result into the cancellation error. A caller cancellation with the default `Canceled` code is not a circuit failure; a caller `ConnectError` reason that carries an infrastructure code (for example `Unavailable`) is counted under its own code. If timeouts must not trip the breaker, pass a `failurePredicate` that excludes `DeadlineExceeded`.
  
  Public options, defaults and chain order are unchanged. Streaming stays skipped by default; with `skipStreaming: false` the timeout and retry cover opening the response only, and caller cancellation still reaches an opened stream. See "Cancellation behavior in 1.3" in the interceptors README for migration notes.
  
  `@connectum/test-fixtures`: mock requests now carry an independent, non-aborted `signal`, as the ConnectRPC request contract requires.

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

- [#315](https://github.com/Connectum-Framework/connectum/pull/315) [`698db2a`](https://github.com/Connectum-Framework/connectum/commit/698db2a04a34f087600747bfe8e34e55e6ae537a) Thanks [@intech](https://github.com/intech)! - fix: the logger interceptor can no longer change the outcome of a call, and it now logs failures and stream ends correctly
  
  - A log sink that throws, or returns a promise that rejects (an `async` function), no longer turns a successful response into `Internal`, replaces the real error of a failed call or surfaces as an unhandled rejection. The first sink failure is reported once on the console; later ones are dropped, and a console that throws while reporting changes nothing either.
  - A failed call is logged as `RPC <path> failed with <Code>` (the Connect code name, `Unknown` for a plain error); the original error reaches the caller unchanged.
  - For a streamed response the `completed in N ms` line is written when the stream ends (fully read, failed midway, or abandoned by the reader), so the duration covers the stream. Before, it was written when the stream was created, ahead of the first message.
  - A streamed message that cannot be converted to JSON is logged as a marker instead of ending the stream with an error.
  
  What is printed for a call by default is unchanged apart from the new failure line and the position of the completion line of streams.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

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
  that broke `turbo build` and forced the workspace build to fall back to
  `pnpm -r --workspace-concurrency=1 build`.

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

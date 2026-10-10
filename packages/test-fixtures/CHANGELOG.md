# @connectum/test-fixtures

## 1.3.0

### Minor Changes

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

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

## 1.2.0

## 1.1.0

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

## 1.0.0

### Minor Changes

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

### Patch Changes

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

- [#158](https://github.com/Connectum-Framework/connectum/pull/158) [`6201cf2`](https://github.com/Connectum-Framework/connectum/commit/6201cf2ea269e247d2a4366dff6387deec73e3d8) Thanks [@intech](https://github.com/intech)! - fix: bound the matched input in `assertConnectError`; align `engines.node`

  `assertConnectError` now matches `messagePattern` against a 1000-char slice of the error message rather than the full string. The function already failed fast on messages longer than 1000 chars; making the bound explicit at the match site is a bounded-input mitigation (it caps the matched length, not regex complexity — the pattern is test-author controlled, not attacker input) and clears the `js/polynomial-redos` static-analysis finding. Also aligns `@connectum/test-fixtures` `engines.node` to the published consumer floor (`>=22.13.0`, was `>=20.0.0`) for consistency with the other packages.

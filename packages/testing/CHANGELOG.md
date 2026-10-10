# @connectum/testing

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

- [#281](https://github.com/Connectum-Framework/connectum/pull/281) [`0162e26`](https://github.com/Connectum-Framework/connectum/commit/0162e268a58f0262910bd000e8ff4ff2dc4d34c6) Thanks [@intech](https://github.com/intech)! - feat(core): server-level `requestGate` and `readMaxBytes` in `createServer()`
  
  - **`requestGate`** is Connect's gate, set as a server-wide default. It receives the call's `HandlerContext` after the headers arrive and before any request message is received, decompressed or parsed. Throw a `ConnectError` to reject the call without reading the body.
  - **`readMaxBytes`** is a server-wide per-message read limit. A larger message ends with `ResourceExhausted` before the handler runs.
  - **Both are opt-in and unset by default.** Servers that do not set them behave exactly as before.
  - **Identical on both transports.** Both options apply the same way over HTTP and in-process: `server.localClient()`, `createLocalTransport()`, and `ctx.call` / `ctx.stream` to a local service.
    - There is no in-process exemption. An internal `ctx.call` carries only the headers you forward with `propagateHeaders` or `outgoingInterceptors`.
  - **Service values override.** A service's own `requestGate` or `readMaxBytes` in `ServiceOptions` replaces the server default for that service. They are not composed, and the server value is not a ceiling.
  - **Gate errors bypass `errorHandler`.** A gate runs before the server interceptors. A thrown `ConnectError` reaches the client as thrown, so give it a client-safe message. Anything else is replaced by Connect with `internal error` (`Code.Internal`); its text never reaches the client.
  - **Invalid values fail fast.** `createServer()` throws a `RangeError` naming the option when `readMaxBytes` is not an integer from 1 to 4294967295 (`0`, negatives, fractions, `NaN`, `Infinity`), and a `TypeError` for a non-number `readMaxBytes` or a non-function `requestGate`. Left to Connect, `NaN` would silently disable the limit.
  - **No server-side telemetry for rejections.** A rejected call produces no server span, metric or log entry. Wrap the gate yourself to audit rejections.
  - **What the gate covers.** Every RPC on the router is gated, including gRPC Health and Reflection. HTTP endpoints served by protocol HTTP handlers, such as `/healthz`, are not.
  - **Cancellation is cooperative.** `context.signal` aborts on the call's deadline, on client cancellation, and when `server.stop()` begins, on both transports.
  - **Security fix.** HTTP requests now have a forged `connectum-internal-transport` header deleted before Connect builds the request. Previously it was removed only by an interceptor, which runs after a gate. Any gate, server-level or per-service, could therefore observe a forged in-process marker.
  - **`@connectum/testing`:**
    - `transportParityTest()` accepts `requestGate` and `readMaxBytes` and applies them to both servers.
    - `defaultCompare` treats one documented difference as equal: a `readMaxBytes` diagnostic text that includes the observed size on one transport and omits it on the other, for the same configured limit.

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

- [#309](https://github.com/Connectum-Framework/connectum/pull/309) [`5f61717`](https://github.com/Connectum-Framework/connectum/commit/5f617172b1074544282eaf9ed9b1287bc8928b20) Thanks [@intech](https://github.com/intech)! - fix: cancelling a streaming call now finishes the handler's output stream on every transport and runtime
  
  - A streaming handler parked at `yield` only unwinds when something pulls its generator again. Over `server.localClient()` / `createLocalTransport()` nothing pulls once the client stops reading, so the handler kept an aborted `ctx.signal` but never reached its `finally`: cursors, subscriptions and handles opened before the `yield` leaked. Over HTTP/2 the server pumps the generator into the socket, but whether a cancelled call is noticed there depends on the runtime: on Node 26.10.0 and under Bun the handler stayed parked as well. Both paths now finish the handler's output iterator when the call's signal aborts (client `AbortSignal`, deadline, `server.stop()`); an abort that arrives while the handler is inside an `await` finishes it right after that step, never concurrently.
  - Leaving a `for await` loop with `break` is still not a cancellation on either transport: the handler keeps running until the call is aborted or the server stops.
  - `@connectum/testing`: two parity scenarios (abort, and break followed by abort) compare what the handler observes on both transports, not only what the client sees.

- [#310](https://github.com/Connectum-Framework/connectum/pull/310) [`fd8f5ea`](https://github.com/Connectum-Framework/connectum/commit/fd8f5eaa2f5bce151f49953e91b9b8a1b14d03d0) Thanks [@intech](https://github.com/intech)! - `@connectum/otel`: the OTLP/HTTP exporters no longer fail when no collector endpoint is configured.
  
  With `OTEL_TRACES_EXPORTER=otlp/http` (or the metrics/logs equivalents) and no `OTEL_EXPORTER_OTLP_ENDPOINT`, creating the provider used to throw `Could not parse user-provided export URL: 'undefined/v1/traces'`. The exporter now falls back to its default, `http://localhost:4318/v1/<signal>`; an empty `OTEL_EXPORTER_OTLP_ENDPOINT` counts as not set. A malformed endpoint still fails at construction.
  
  The documented OpenTelemetry environment contract is now honoured:
  
  - `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and `OTEL_LOGS_EXPORTER` accept the standard value `otlp`. The transport follows `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL`, then `OTEL_EXPORTER_OTLP_PROTOCOL` (`grpc`, `http/protobuf`, `http/json`). `http/protobuf`, which is also the default when neither is set, sends protobuf-encoded OTLP/HTTP (`Content-Type: application/x-protobuf`) as the OpenTelemetry specification defines; `http/json` sends JSON. `otlp/http` (JSON, unchanged), the new `otlp/http-protobuf` and `otlp/grpc` are explicit and ignore the protocol variables. The package gains the three `@opentelemetry/exporter-*-otlp-proto` dependencies.
  - `OTEL_EXPORTER_OTLP_<TRACES|METRICS|LOGS>_ENDPOINT` is used as given and now takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT` for OTLP/HTTP exporters; previously the base endpoint silently won when both were set.
  
  `ExporterType` gains `OTLP_HTTP_PROTOBUF` (`"otlp/http-protobuf"`), so `settings` overrides can select the binary encoding too.
  
  `@connectum/testing`: `InMemoryMetricCollector` names its aggregation temporality (`AggregationTemporality.DELTA`) instead of the bare `0`, and the comment that called it CUMULATIVE is corrected. Behaviour is unchanged.

- [#278](https://github.com/Connectum-Framework/connectum/pull/278) [`f4dc088`](https://github.com/Connectum-Framework/connectum/commit/f4dc0888255c9c9cf1c2e9bba2b18a7341bcf95d) Thanks [@intech](https://github.com/intech)! - feat(otel): export the `OtelProvider` type returned by `getProvider()`
  
  - `@connectum/otel`: `getProvider()` returned a type the package did not
    export, so callers could not name it to store or pass the provider on. It is
    now exported (from the root entry and from `@connectum/otel/provider`) as an
    interface — `tracer`, `meter`, `logger` and `shutdown()` — with no public
    constructor: the package still keeps exactly one provider per process.
    `provider.shutdown()` does not reset that instance; `shutdownProvider()` does.
  - `@connectum/testing`: the `InMemorySpanCollector` docs named a
    `registerGlobal` method that does not exist. They now describe the real way to
    make the collector global: `trace.setGlobalTracerProvider(collector.provider)`,
    then `trace.disable()` before `dispose()`.
  - `@connectum/healthcheck`: the `ServingStatus` docs list the enum values of the
    gRPC Health Checking Protocol it re-exports.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.
- Updated dependencies [[`1a3b49b`](https://github.com/Connectum-Framework/connectum/commit/1a3b49b51cd99deba325db946e2b241d51cf9c1d), [`e279cbd`](https://github.com/Connectum-Framework/connectum/commit/e279cbd09fe4a064a00370f62f6b78c2d947182d), [`0305b23`](https://github.com/Connectum-Framework/connectum/commit/0305b237899dd1b2e12adbb5adaee88835e65e9b), [`43394b3`](https://github.com/Connectum-Framework/connectum/commit/43394b382f3d8837b9921b74fad904b618119453), [`10a3e58`](https://github.com/Connectum-Framework/connectum/commit/10a3e584a1f8c6c80d96c533d88dc02300805289), [`0162e26`](https://github.com/Connectum-Framework/connectum/commit/0162e268a58f0262910bd000e8ff4ff2dc4d34c6), [`5f61717`](https://github.com/Connectum-Framework/connectum/commit/5f617172b1074544282eaf9ed9b1287bc8928b20), [`36ce828`](https://github.com/Connectum-Framework/connectum/commit/36ce828cd36d84285e657b843b65ddbf28111107), [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5), [`0cc15bb`](https://github.com/Connectum-Framework/connectum/commit/0cc15bb38fe23d8e9ac1a4b669b97c0b496d5e76), [`bc770be`](https://github.com/Connectum-Framework/connectum/commit/bc770bee1669e91804f6115b5dfe2e254f129760), [`5f0038d`](https://github.com/Connectum-Framework/connectum/commit/5f0038d267cf6b1b6d058e9b7cc8dd275a18080e), [`7f5317a`](https://github.com/Connectum-Framework/connectum/commit/7f5317a80c262048acefbb3eb3562704b4c95d3d), [`0162e26`](https://github.com/Connectum-Framework/connectum/commit/0162e268a58f0262910bd000e8ff4ff2dc4d34c6), [`8ae4fca`](https://github.com/Connectum-Framework/connectum/commit/8ae4fca7c095b8fca74c41c4cb9e93f7695c893e), [`8f82559`](https://github.com/Connectum-Framework/connectum/commit/8f825599513ecff3c34d51965c46aab597e7be38), [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a), [`6f342ac`](https://github.com/Connectum-Framework/connectum/commit/6f342acfb59c296020435b779d7c8f7bd79acee6)]:
  - @connectum/core@1.3.0
  - @connectum/test-fixtures@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.2.0
  - @connectum/test-fixtures@1.2.0

## 1.1.0

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

- Updated dependencies [[`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39), [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae)]:
  - @connectum/core@1.1.0
  - @connectum/test-fixtures@1.1.0

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

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

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

- [#152](https://github.com/Connectum-Framework/connectum/pull/152) [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837) Thanks [@intech](https://github.com/intech)! - feat(testing): mock resolver + mock handler context for the service catalog

  - **`mockResolver(mocks)` / `mockService(service, impl)`** — a `RemoteResolver`
    that serves canned implementations in-process; every response is tagged with
    `x-connectum-mock: true` (`MOCK_RESPONSE_HEADER`) so tests can prove a call was
    mock-served. Returns `null` for unmocked services, so it composes with real
    resolvers.
  - **`createMockContext({ catalog, mocks, ... })`** — build a Connectum `Context`
    for unit-testing a handler's `ctx.call` / `ctx.stream` in isolation. It drives
    the SAME catalog dispatch path as a live request (resolver lookup, cascade,
    interceptors, error semantics), so there is no parallel mock path to drift
    from.

- [#41](https://github.com/Connectum-Framework/connectum/pull/41) [`fccee26`](https://github.com/Connectum-Framework/connectum/commit/fccee264ec7ed685348a7590057ec8316f21ef1a) Thanks [@intech](https://github.com/intech)! - Implement @connectum/testing utilities package with 13 factory functions for ConnectRPC testing.

  **Phase 1 (P0)**: `createMockRequest`, `createMockNext`, `createMockNextError`, `createMockNextSlow`, `assertConnectError`
  **Phase 2 (P1)**: `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`, `createMockStream`, `createFakeService`, `createFakeMethod`
  **Phase 3 (P2)**: `createTestServer`, `withTestServer`

  Eliminates 135+ test boilerplate duplicates across interceptors, auth, otel, and core packages. All migrated packages now use shared testing utilities instead of inline mock objects.

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

- [#156](https://github.com/Connectum-Framework/connectum/pull/156) [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4) Thanks [@intech](https://github.com/intech)! - fix: make `@connectum/testing/parity` importable by preserving the `node:` protocol prefix

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). For `node:test` that is fatal — the unprefixed `test` has no bare builtin equivalent, so the published `dist/parity.js` shipped `import { test } from "test"` and threw `Cannot find package 'test'` in every consumer of the `./parity` subpath. Setting `removeNodeProtocol: false` keeps `node:test` (and other builtins) intact; the consumer floor is Node >=22.13 where the prefix is required for `node:test` and supported for every builtin.

- [#93](https://github.com/Connectum-Framework/connectum/pull/93) [`5671e77`](https://github.com/Connectum-Framework/connectum/commit/5671e775a0bb86fc7e1ed2400304653553bf5b34) Thanks [@intech](https://github.com/intech)! - fix(testing): replace node:test mock with portable implementation

  Replaced `mock.fn()` from `node:test` with a portable `createMockFn()`
  implementation that works across Node.js, Bun, and bundler environments.
  The public API surface (`.mock.calls`, `.mock.callCount()`) is preserved.

  This unblocks Bun users from using `@connectum/testing` utilities.

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06), [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2), [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302), [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`6201cf2`](https://github.com/Connectum-Framework/connectum/commit/6201cf2ea269e247d2a4366dff6387deec73e3d8), [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837), [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e), [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0
  - @connectum/test-fixtures@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- [#93](https://github.com/Connectum-Framework/connectum/pull/93) [`5671e77`](https://github.com/Connectum-Framework/connectum/commit/5671e775a0bb86fc7e1ed2400304653553bf5b34) Thanks [@intech](https://github.com/intech)! - fix(testing): replace node:test mock with portable implementation

  Replaced `mock.fn()` from `node:test` with a portable `createMockFn()`
  implementation that works across Node.js, Bun, and bundler environments.
  The public API surface (`.mock.calls`, `.mock.callCount()`) is preserved.

  This unblocks Bun users from using `@connectum/testing` utilities.

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.9

## 1.0.0-rc.8

### Patch Changes

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda)]:
  - @connectum/core@1.0.0-rc.8

## 1.0.0-rc.7

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.7

## 1.0.0-rc.6

### Minor Changes

- [#41](https://github.com/Connectum-Framework/connectum/pull/41) [`fccee26`](https://github.com/Connectum-Framework/connectum/commit/fccee264ec7ed685348a7590057ec8316f21ef1a) Thanks [@intech](https://github.com/intech)! - Implement @connectum/testing utilities package with 13 factory functions for ConnectRPC testing.

  **Phase 1 (P0)**: `createMockRequest`, `createMockNext`, `createMockNextError`, `createMockNextSlow`, `assertConnectError`
  **Phase 2 (P1)**: `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`, `createMockStream`, `createFakeService`, `createFakeMethod`
  **Phase 3 (P2)**: `createTestServer`, `withTestServer`

  Eliminates 135+ test boilerplate duplicates across interceptors, auth, otel, and core packages. All migrated packages now use shared testing utilities instead of inline mock objects.

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

- Updated dependencies [[`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177)]:
  - @connectum/core@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06)]:
  - @connectum/core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- Updated dependencies [[`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e)]:
  - @connectum/core@1.0.0-rc.2

## 1.0.0-beta.2

### Patch Changes

- Updated dependencies
- Updated dependencies [4e784c1]
  - @connectum/core@1.0.0-beta.2

## 0.2.0-beta.1

### Patch Changes

- chore: clean up package dependencies
- chore: update dependencies

## 0.2.0-alpha.2

Initial alpha release.

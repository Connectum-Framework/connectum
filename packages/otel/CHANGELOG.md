# @connectum/otel

## 1.3.0

### Minor Changes

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

- [#334](https://github.com/Connectum-Framework/connectum/pull/334) [`2b09e10`](https://github.com/Connectum-Framework/connectum/commit/2b09e1080bd3d4d1af923254f7b637b7bb664d77) Thanks [@intech](https://github.com/intech)! - fix: the server span is now the active span inside server-streaming and bidirectional handlers.
  
  `trace.getActiveSpan()` used to be empty in such a handler over HTTP (and returned the caller's or the client span in-process), in every phase: at the start, after an `await`, after a `yield` and in `finally`. A span the handler started, including through `traced()`, was therefore not a child of the server span. `createOtelInterceptor()` now runs the creation of the response stream and each of its `next`, `return` and `throw` steps in the context that carries the server span, so the whole handler runs under it and its spans are parented to it. Unary and client-streaming handlers, span names, attributes, events, status and metrics are unchanged. The scope ends with each step: the code that consumes the stream keeps its own active span and concurrent streams stay separate.
  
  The helper `scopeAsyncIterable` is exported from `@connectum/otel/shared` next to `wrapAsyncIterable`; no other API changes.
  
  The request stream is pulled by code below the interceptor (the handler, or an interceptor placed after it), so it already runs under the server span and is not re-scoped: an interceptor placed before `createOtelInterceptor()` that wraps the request stream still sees the server span while it is pulled, as before. Wrappers of the response stream run under the server span only when they are placed after `createOtelInterceptor()`; put `createLoggerInterceptor()` after it to have its response and completion records correlated with the span. In-process, the generator that produces the request messages of a bidirectional call now also runs under the server span, as it already did for client-streaming calls.

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

- [#311](https://github.com/Connectum-Framework/connectum/pull/311) [`45510a5`](https://github.com/Connectum-Framework/connectum/commit/45510a5fad8b369fe04bd7358659471e0819c329) Thanks [@intech](https://github.com/intech)! - `@connectum/otel`: `shutdownProvider()` no longer leaves the provider in a broken state, and a provider created after a shutdown now works.
  
  - When stopping failed (for example an unreachable OTLP collector), `getProvider()` kept handing out the half-stopped provider and a repeated `shutdownProvider()` returned the same error. The provider is now released whether stopping succeeds or fails; the call still rejects with the failure.
  - Tracing, metrics and logging used to be stopped one after another, so a failing first signal left the other two running with unflushed buffers. They are now stopped independently; one failure is rethrown as it is, several as an `AggregateError`.
  - The OpenTelemetry API global registrations (trace, context, propagation, metrics, logs) survived a shutdown, so a provider created afterwards was refused as a duplicate and its `meter` became a no-op: RPC metrics disappeared without a message. Shutdown now releases exactly the registrations the provider took and leaves those held by other code alone, and the provider's `meter` comes from its own meter provider.
  - `createOtelInterceptor` and `createOtelClientInterceptor` created before a shutdown kept recording into the stopped meter provider; they now follow the current one.
  
  The package now lists `@opentelemetry/context-async-hooks` and `@opentelemetry/core` as dependencies (they were development-only) because the provider registers the context manager and the propagator itself.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

- [#308](https://github.com/Connectum-Framework/connectum/pull/308) [`6f342ac`](https://github.com/Connectum-Framework/connectum/commit/6f342acfb59c296020435b779d7c8f7bd79acee6) Thanks [@intech](https://github.com/intech)! - Internal hardening, no behaviour change: the linter now enforces a stricter rule set
  (no import cycles, no namespace imports, no bitwise operators, no `== null`, no `var`,
  no unguarded `for...in`, and others), and the sources were brought in line with it.
  
  The CIDR check behind the gateway trust source is now plain integer arithmetic instead
  of signed 32-bit shifts, so no prefix length can flip the high bit; every prefix
  boundary, including `/0`, `/1`, `/31` and `/32`, is covered by a test. The catalog
  generator emits its `catalog.gen.ts` through `print(...)` calls rather than tagged
  templates; a test pins the exact generated text line for line.

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

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

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

- [#117](https://github.com/Connectum-Framework/connectum/pull/117) [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e) Thanks [@intech](https://github.com/intech)! - feat(otel): export RPC message-event semantic conventions from the package root

  `ATTR_RPC_MESSAGE_ID`, `ATTR_RPC_MESSAGE_TYPE`, `ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE`,
  and `RPC_MESSAGE_EVENT` are now re-exported from the root `@connectum/otel`
  entrypoint, alongside the other `ATTR_RPC_*` / `RPC_*` semantic-convention
  constants. Previously they were reachable only via the `@connectum/otel/attributes`
  subpath, which was inconsistent with the rest of the streaming-span attributes and
  broke documented root-level imports.

- [#147](https://github.com/Connectum-Framework/connectum/pull/147) [`d2ea2ca`](https://github.com/Connectum-Framework/connectum/commit/d2ea2ca79f456c8121752c203acccbf23b9162f2) Thanks [@intech](https://github.com/intech)! - Support `service.instance.id` and custom resource attributes in `initProvider`.

  `ProviderOptions` gains two optional, backwards-compatible fields:

  - `instanceId` — sets `service.instance.id` on the resource (OTel semconv), so a
    fleet of same-role processes can be told apart in telemetry.
  - `resourceAttributes` — extra resource attributes (e.g. `device.id`,
    `facility`) merged into the resource.

  The standard `OTEL_SERVICE_INSTANCE_ID` and `OTEL_RESOURCE_ATTRIBUTES` env vars
  are now honored, with explicit options taking precedence. The resource is built
  once and shared across traces, metrics, and logs so instance id and custom
  attributes apply consistently to every signal (previously the resource was
  built three times from service name/version only). Existing callers are
  unaffected — all new fields are optional.

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add streaming RPC instrumentation and semantic conventions alignment.

  - Instrument client/server streaming RPCs (span lifecycle deferred to stream completion)
  - Align attribute names with OpenTelemetry RPC semantic conventions
  - Add comprehensive semconv and streaming unit tests

- [#146](https://github.com/Connectum-Framework/connectum/pull/146) [`90b5975`](https://github.com/Connectum-Framework/connectum/commit/90b597552dacfb5de6e2543fe6509e2e96bb18c1) Thanks [@intech](https://github.com/intech)! - Upgrade OpenTelemetry to `0.219.0` (experimental) / `2.8.0` (stable).

  The experimental packages (`exporter-*-otlp-{grpc,http}`, `api-logs`,
  `instrumentation`, `sdk-logs`, `sdk-node`, `auto-instrumentations-node`) move
  from `0.215.0` to `0.219.0`, and the stable packages (`core`, `resources`,
  `sdk-metrics`, `sdk-trace-node`) from `2.7.0` to `2.8.0`. The stale
  `@opentelemetry/core` catalog specifier `^1.28.0` is corrected to `^2.8.0`.

  This removes the duplicate `protobufjs@8.x` copy from the dependency tree:
  `@opentelemetry/otlp-transformer` dropped its `protobufjs` dependency in
  `0.218.0` (replaced by an in-house OTLP serializer). The OTLP wire output is
  unchanged, and both OTLP/gRPC and OTLP/HTTP exporters remain exported — no
  public API or behavior change. The remaining `protobufjs@7.x` copy is the
  transitive `@grpc/grpc-js` dependency of the OTLP/gRPC transport, out of scope
  here.

### Patch Changes

- [#98](https://github.com/Connectum-Framework/connectum/pull/98) [`15f4dbb`](https://github.com/Connectum-Framework/connectum/commit/15f4dbbe919041e1b7337fe30b3243baf55a0129) Thanks [@intech](https://github.com/intech)! - Bump OpenTelemetry SDK to 0.215.0 / v2.7.0 and semantic conventions to 1.40.0.

  Highlights (auto-gain, no API changes in `@connectum/otel`):

  - Hand-rolled `ProtobufLogsSerializer` (PR open-telemetry/opentelemetry-js#6390, v0.215.0) — +67–73% throughput for typical batch sizes (100–1024 logs); +72% at 512 logs, +67% at 1024 logs per upstream benchmarks in PR [#6228](https://github.com/Connectum-Framework/connectum/issues/6228)
  - `cardinalitySelector` support in `PeriodicExportingMetricReader` (PR [#6460](https://github.com/Connectum-Framework/connectum/issues/6460), v2.7.0) — protection against cardinality explosion on high-variance attributes
  - SDK self-observability: span + log creation metrics (PRs [#6213](https://github.com/Connectum-Framework/connectum/issues/6213), [#6433](https://github.com/Connectum-Framework/connectum/issues/6433))
  - Internal `mergeTwoObjects` safety checks (PR [#6587](https://github.com/Connectum-Framework/connectum/issues/6587), v2.7.0) — additional guards against unsafe key merges
  - Updated semantic conventions (semconv v1.40.0) — stable RPC attributes including `rpc.response.status_code` and `error.type` (stabilized in semconv v1.39.0)

  Breaking changes upstream that do NOT affect `@connectum/otel` (verified):

  - Custom `LogRecordExporter.forceFlush()` requirement — not applicable (we use stock exporters only)
  - gRPC exporter config `headers` field removal — not applicable (`CollectorOptions` has no `headers`)

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

- [#66](https://github.com/Connectum-Framework/connectum/pull/66) [`df63c47`](https://github.com/Connectum-Framework/connectum/commit/df63c47bb0886a60ef8551a6b62a7af3041e389d) Thanks [@intech](https://github.com/intech)! - Make initProvider() idempotent instead of throwing on repeated calls

  Previously, calling initProvider() after getMeter()/getTracer()/getLogger()
  (which auto-initialize the provider) would throw "already initialized".
  Now initProvider() is a no-op if provider already exists, matching the
  documented behavior that explicit initialization is optional.

- [#99](https://github.com/Connectum-Framework/connectum/pull/99) [`5b3f01d`](https://github.com/Connectum-Framework/connectum/commit/5b3f01d8fdbe50afe1c3b074cf08f40f4f00458f) Thanks [@intech](https://github.com/intech)! - security(deps): force patched versions of protobufjs and basic-ftp via pnpm overrides

  Resolves Dependabot alerts on main branch:

  - **GHSA-xq3m-2v4x-88gg** (Critical) — Arbitrary code execution in protobufjs < 7.5.5
    (transitive via `@grpc/proto-loader` under OTel gRPC exporters).
  - **GHSA-xq3m-2v4x-88gg** (Critical) — Arbitrary code execution in protobufjs 8.0.0
    (transitive via `@opentelemetry/otlp-transformer`).
  - **GHSA-chqc-8p9q-pq6q** (High) — basic-ftp 5.2.0 FTP Command Injection via CRLF
    (dev-only transitive via `@exodus/test` → puppeteer-core).
  - **GHSA-6v7q-wjvx-w8wg** (High) — basic-ftp ≤ 5.2.1 incomplete CRLF protection
    (dev-only transitive via `@exodus/test` → puppeteer-core).

  No runtime API changes. Only `pnpm.overrides` in the monorepo root were adjusted
  to force patched transitive versions: `protobufjs@<7.5.5 → 7.5.5`,
  `protobufjs@>=8.0.0 <8.0.1 → 8.0.1`, `basic-ftp@<5.2.2 → 5.2.2`.

## 1.0.0-rc.11

### Patch Changes

- [#98](https://github.com/Connectum-Framework/connectum/pull/98) [`15f4dbb`](https://github.com/Connectum-Framework/connectum/commit/15f4dbbe919041e1b7337fe30b3243baf55a0129) Thanks [@intech](https://github.com/intech)! - Bump OpenTelemetry SDK to 0.215.0 / v2.7.0 and semantic conventions to 1.40.0.

  Highlights (auto-gain, no API changes in `@connectum/otel`):

  - Hand-rolled `ProtobufLogsSerializer` (PR open-telemetry/opentelemetry-js#6390, v0.215.0) — +67–73% throughput for typical batch sizes (100–1024 logs); +72% at 512 logs, +67% at 1024 logs per upstream benchmarks in PR [#6228](https://github.com/Connectum-Framework/connectum/issues/6228)
  - `cardinalitySelector` support in `PeriodicExportingMetricReader` (PR [#6460](https://github.com/Connectum-Framework/connectum/issues/6460), v2.7.0) — protection against cardinality explosion on high-variance attributes
  - SDK self-observability: span + log creation metrics (PRs [#6213](https://github.com/Connectum-Framework/connectum/issues/6213), [#6433](https://github.com/Connectum-Framework/connectum/issues/6433))
  - Internal `mergeTwoObjects` safety checks (PR [#6587](https://github.com/Connectum-Framework/connectum/issues/6587), v2.7.0) — additional guards against unsafe key merges
  - Updated semantic conventions (semconv v1.40.0) — stable RPC attributes including `rpc.response.status_code` and `error.type` (stabilized in semconv v1.39.0)

  Breaking changes upstream that do NOT affect `@connectum/otel` (verified):

  - Custom `LogRecordExporter.forceFlush()` requirement — not applicable (we use stock exporters only)
  - gRPC exporter config `headers` field removal — not applicable (`CollectorOptions` has no `headers`)

- [#99](https://github.com/Connectum-Framework/connectum/pull/99) [`5b3f01d`](https://github.com/Connectum-Framework/connectum/commit/5b3f01d8fdbe50afe1c3b074cf08f40f4f00458f) Thanks [@intech](https://github.com/intech)! - security(deps): force patched versions of protobufjs and basic-ftp via pnpm overrides

  Resolves Dependabot alerts on main branch:

  - **GHSA-xq3m-2v4x-88gg** (Critical) — Arbitrary code execution in protobufjs < 7.5.5
    (transitive via `@grpc/proto-loader` under OTel gRPC exporters).
  - **GHSA-xq3m-2v4x-88gg** (Critical) — Arbitrary code execution in protobufjs 8.0.0
    (transitive via `@opentelemetry/otlp-transformer`).
  - **GHSA-chqc-8p9q-pq6q** (High) — basic-ftp 5.2.0 FTP Command Injection via CRLF
    (dev-only transitive via `@exodus/test` → puppeteer-core).
  - **GHSA-6v7q-wjvx-w8wg** (High) — basic-ftp ≤ 5.2.1 incomplete CRLF protection
    (dev-only transitive via `@exodus/test` → puppeteer-core).

  No runtime API changes. Only `pnpm.overrides` in the monorepo root were adjusted
  to force patched transitive versions: `protobufjs@<7.5.5 → 7.5.5`,
  `protobufjs@>=8.0.0 <8.0.1 → 8.0.1`, `basic-ftp@<5.2.2 → 5.2.2`.

## 1.0.0-rc.10

## 1.0.0-rc.9

## 1.0.0-rc.8

## 1.0.0-rc.7

### Patch Changes

- [#66](https://github.com/Connectum-Framework/connectum/pull/66) [`df63c47`](https://github.com/Connectum-Framework/connectum/commit/df63c47bb0886a60ef8551a6b62a7af3041e389d) Thanks [@intech](https://github.com/intech)! - Make initProvider() idempotent instead of throwing on repeated calls

  Previously, calling initProvider() after getMeter()/getTracer()/getLogger()
  (which auto-initialize the provider) would throw "already initialized".
  Now initProvider() is a no-op if provider already exists, matching the
  documented behavior that explicit initialization is optional.

## 1.0.0-rc.6

## 1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add streaming RPC instrumentation and semantic conventions alignment.

  - Instrument client/server streaming RPCs (span lifecycle deferred to stream completion)
  - Align attribute names with OpenTelemetry RPC semantic conventions
  - Add comprehensive semconv and streaming unit tests

## 1.0.0-rc.3

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

### Patch Changes

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

## 0.2.0-beta.1

### Minor Changes

- feat: `createOtelClientInterceptor` — client-side RPC tracing + context propagation
- feat: `getLogger()` — unified correlated logger with auto-inject service name from active span (`info`/`warn`/`error`/`debug` + raw `emit`)

### Patch Changes

- refactor: unified OTel interceptor, remove tracing from interceptors package
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.

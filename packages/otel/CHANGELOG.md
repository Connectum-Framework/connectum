# @connectum/otel

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

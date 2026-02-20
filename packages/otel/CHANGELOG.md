# @connectum/otel

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

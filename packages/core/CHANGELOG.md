# @connectum/core

## 1.0.0-rc.1

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

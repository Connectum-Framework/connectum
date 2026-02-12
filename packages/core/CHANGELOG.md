# @connectum/core

## 1.0.0-beta.2

### Minor Changes

- 4e784c1: refactor: удалён пакет @connectum/utilities

  **BREAKING**: Пакет `@connectum/utilities` полностью удалён из монорепозитория.

  Причины удаления:

  - 0 реальных потребителей — ни один пакет не импортировал utilities
  - Все функции имели лучшие альтернативы (Node.js built-ins или battle-tested npm пакеты)
  - 2 критических бага: утечка таймера в withTimeout, сломанный LRU cache (FIFO вместо LRU)
  - 6 из 9 модулей без тестов

  Таблица замен:

  - `retry()` → `cockatiel` (уже в проекте)
  - `sleep()` → `import { setTimeout } from 'node:timers/promises'`
  - `withTimeout()` → `AbortSignal.timeout(ms)` (Node.js built-in)
  - `LRUCache` → `lru-cache` npm
  - `safeStringify()` → `safe-stable-stringify` npm
  - `Observable` → `EventEmitter` из `node:events`
  - `Monitor` → `events.on()` из `node:events`

  Перемещения:

  - `ConnectumEnvSchema`, `parseEnvConfig`, `safeParseEnvConfig` → `@connectum/core/config`

  Другие изменения:

  - `@connectum/otel`: удалена phantom dependency на utilities (не использовалась)

### Patch Changes

- Code review: критические фиксы, декомпозиция ServerImpl, фабрика HealthcheckManager, unit-тесты

  **core:**

  - Fix Promise.race error swallowing в graceful shutdown
  - Fix error listener leak при синхронном throw в listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only в watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy в HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers в fallback response
  - Improve bulkhead error message
  - Consistent await в serializer
  - Fix double type cast в errorHandler

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

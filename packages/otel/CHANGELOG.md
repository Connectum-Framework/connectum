# @connectum/otel

## 1.0.0-beta.2

### Patch Changes

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

## 0.2.0-beta.1

### Minor Changes

- feat: `createOtelClientInterceptor` — client-side RPC tracing + context propagation
- feat: `getLogger()` — unified correlated logger with auto-inject service name from active span (`info`/`warn`/`error`/`debug` + raw `emit`)

### Patch Changes

- refactor: unified OTel interceptor, remove tracing from interceptors package
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.

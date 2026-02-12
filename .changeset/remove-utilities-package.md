---
"@connectum/core": minor
"@connectum/otel": patch
---

refactor: удалён пакет @connectum/utilities

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

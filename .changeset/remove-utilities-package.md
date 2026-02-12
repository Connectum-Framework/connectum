---
"@connectum/core": minor
"@connectum/otel": patch
---

refactor: removed @connectum/utilities package

**BREAKING**: The `@connectum/utilities` package has been completely removed from the monorepo.

Reasons for removal:
- 0 real consumers — no package imported utilities
- All functions had better alternatives (Node.js built-ins or battle-tested npm packages)
- 2 critical bugs: timer leak in withTimeout, broken LRU cache (FIFO instead of LRU)
- 6 out of 9 modules had no tests

Replacement table:
- `retry()` → `cockatiel` (already in the project)
- `sleep()` → `import { setTimeout } from 'node:timers/promises'`
- `withTimeout()` → `AbortSignal.timeout(ms)` (Node.js built-in)
- `LRUCache` → `lru-cache` npm
- `safeStringify()` → `safe-stable-stringify` npm
- `Observable` → `EventEmitter` from `node:events`
- `Monitor` → `events.on()` from `node:events`

Relocated:
- `ConnectumEnvSchema`, `parseEnvConfig`, `safeParseEnvConfig` → `@connectum/core/config`

Other changes:
- `@connectum/otel`: removed phantom dependency on utilities (was not used)

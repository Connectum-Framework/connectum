---
"@connectum/core": minor
"@connectum/interceptors": minor
"@connectum/healthcheck": minor
"@connectum/reflection": minor
"@connectum/otel": minor
"@connectum/testing": minor
"@connectum/cli": minor
"@connectum/auth": minor
---

Migrate to compile-before-publish with tsup (ADR-001 revision).

All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

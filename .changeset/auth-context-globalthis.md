---
"@connectum/auth": patch
---

fix(auth): make authContextStorage resilient to multiple module evaluations

Uses globalThis + Symbol.for() to ensure a single AsyncLocalStorage instance
per process, even when the module is evaluated through multiple runtime paths
(e.g., tsx source + built workspace output in dev).

Emits a one-time `CONNECTUM_AUTH_DUP_INIT` warning when dual initialization
is detected, helping diagnose mixed src/dist import issues.

Fixes #75. Thanks to @kebr0m for the detailed bug report and root cause analysis.

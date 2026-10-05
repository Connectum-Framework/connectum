---
"@connectum/core": patch
---

fix: invalid `shutdown.timeout`, `shutdown.forceCloseOnTimeout` and a service's own `readMaxBytes` are rejected at creation instead of silently misbehaving.

- `createServer()` throws a `RangeError` for a `shutdown.timeout` that is not an integer from 0 to 2147483647 (`NaN`, `-1`, `Infinity`, a fraction, a larger value) and a `TypeError` for a non-number; a non-boolean `shutdown.forceCloseOnTimeout` throws a `TypeError`. Such timeouts used to fire after about a millisecond and cut live connections at once. `timeout: 0` stays valid.
- `defineService()` and `defineLazyService()` validate `readMaxBytes` in the service options exactly like the server-level option (integer from 1 to 4294967295; `RangeError` / `TypeError` naming the option). `readMaxBytes: NaN` used to disable the limit silently.

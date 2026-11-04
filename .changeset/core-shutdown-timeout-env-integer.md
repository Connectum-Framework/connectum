---
"@connectum/core": minor
---

fix: `GRACEFUL_SHUTDOWN_TIMEOUT_MS` must be a whole number of milliseconds. `parseEnvConfig()` and `safeParseEnvConfig()` now reject a fractional value such as `1.5` with an issue on `GRACEFUL_SHUTDOWN_TIMEOUT_MS`, where it used to pass and then make `createServer({ shutdown: { timeout } })` throw a `RangeError` that did not name the variable. Whole values from 0 to 300000 are accepted as before.

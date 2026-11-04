---
"@connectum/core": minor
---

fix: an empty or whitespace-only `GRACEFUL_SHUTDOWN_TIMEOUT_MS` is now rejected by `parseEnvConfig()` and `safeParseEnvConfig()` with an issue on `GRACEFUL_SHUTDOWN_TIMEOUT_MS`, the way an empty `PORT` already is. It used to parse to `0`, so `GRACEFUL_SHUTDOWN_TIMEOUT_MS=` in a compose file or a manifest switched connection draining off and `stop()` cut in-flight requests at once. Leave the variable out (or `undefined`) to get the default of 30000.

---
"@connectum/healthcheck": minor
---

fix: `createHttpHealthHandler(manager, healthPaths)` applies the same path rules as the `httpPaths` option of `Healthcheck()`. An empty array throws `RangeError`; a value that is not an array, or an entry that is not a string, does not start with `/`, or contains `?` or `#`, throws `TypeError`, with a message naming `healthPaths`. Before, such a list was accepted and produced a handler that never matched a request. Omitting the argument still serves `/healthz`, `/health` and `/readyz`.

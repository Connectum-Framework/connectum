---
"@connectum/core": minor
---

fix: when a shutdown hook fails, `server.stop()` now runs every other hook and waits for all of them before it emits `stop` and rejects. Before, `stop()` rejected and emitted `stop` as soon as the first hook failed, leaving independent hooks that were still running unawaited (a process that exits on the rejected `stop()` cut them off) and never running the hooks that depended on the failed one. A hook that depends on a failed hook now runs after it has finished, because it releases a resource of its own. `stop()` rejects with the single failure itself, or with an `AggregateError` of all failures in registration order when several hooks failed.

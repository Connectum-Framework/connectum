---
"@connectum/testing": minor
---

fix: `InMemoryMetricCollector.flush()` returns only what was recorded since the previous `flush()` (or since the collector was created or `reset()`), not the data of all earlier flushes plus the new data. A counter incremented between two flushes used to show up as one entry per flush under the same name, so `find(m => m.name === "hits")` returned the stale first entry; it now sees the current value, and a flush with nothing recorded in between returns `[]`. `flush()` after `dispose()` now throws `InMemoryMetricCollector: flush() called after dispose()` instead of returning the old entries, and `dispose()` can be called more than once. Code that read earlier exports from a later `flush()` must keep the earlier results itself.

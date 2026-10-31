---
"@connectum/otel": minor
---

fix: a second `shutdownProvider()` called while the first is still stopping the provider no longer returns at once. It waits for that stop and settles with the same outcome, so a shutdown hook that exits the process cannot run before the flush has finished. If the first call fails, the second now rejects with the same error where it used to resolve.

feat: `shutdownProvider({ timeout })` bounds the wait. With a collector that accepts connections and never answers, the call took up to 10 seconds (the exporter timeout, `OTEL_EXPORTER_OTLP_TIMEOUT`) and rejected with `Timeout`; pass the time the surrounding shutdown can spare and the call rejects with an error named `TimeoutError` when it passes. The provider is released either way, and the exporters keep trying in the background until their own timeout ends. Without the option nothing changes: there is no default deadline, because one shorter than the exporter timeout would silently drop telemetry that a slow collector still accepts.

---
"@connectum/otel": patch
---

fix: telemetry no longer changes the outcome of the call it observes.

- `traced()` and `traceAll()` with `recordArgs` no longer fail the call when the arguments cannot be recorded (a `BigInt`, a circular structure, or an `argsFilter` that throws): the wrapped function runs and returns its own result, and the span simply has no `function.args` attribute.
- Any thrown value is now a failure, including the falsy ones (`null`, `undefined`, `0`, `""`). `traced()`, `traceAll()` and both interceptors used to replace a thrown `null` or `undefined` with an internal `TypeError`, and a stream that raised a falsy value ended as a success. The span now ends with status `ERROR` and a recorded exception, and the caller receives the original value.
- Behaviour change for invalid `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY` and `OTEL_BSP_EXPORT_TIMEOUT` (not an integer, or negative): instead of throwing when the provider is created (which happens on the first traced call), the package now emits a process warning (code `CONNECTUM_OTEL_INVALID_ENV`) and uses the documented default, as the OpenTelemetry specification asks. A deployment that relied on a typo failing at start-up now starts with the default and a warning.

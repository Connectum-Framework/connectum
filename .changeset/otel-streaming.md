---
"@connectum/otel": minor
---

Add streaming RPC instrumentation and semantic conventions alignment.

- Instrument client/server streaming RPCs (span lifecycle deferred to stream completion)
- Align attribute names with OpenTelemetry RPC semantic conventions
- Add comprehensive semconv and streaming unit tests

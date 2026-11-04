---
"@connectum/otel": minor
---

fix: a wrong OpenTelemetry environment variable no longer fails every RPC. The provider is created by the first instrumented call, and reading `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL` or `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL` threw for an empty value, for `OTLP` in upper case and for `otlp,console`, so every call after it ended with `internal error` and the cause stayed in the server. Now an empty value counts as unset, values are matched case-insensitively, and an unrecognised value is ignored with a Node.js process warning (code `CONNECTUM_OTEL_INVALID_ENV`) that names the variable and the value, as the OpenTelemetry specification asks. An unknown protocol is therefore a warning too, where it used to throw when a signal was set to `otlp`.

The same holds for the endpoint. `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` that an exporter cannot use (`localhost:4318` without a scheme over OTLP/HTTP, which failed only when `shutdownProvider()` rejected with `Protocol "localhost:" not supported`; a value that is not a URL, which made creating the provider throw) are reported with a warning when the provider is created and ignored: the base endpoint or the exporter default applies. A bare `host:port` stays valid for OTLP/gRPC. If you relied on the throw to catch a bad endpoint, watch for the warning (`node --trace-warnings`, or `process.on("warning")`).

`getOTLPSettings()` now names the exporter of a signal whose variable is unset, empty or ignored, where it returned `undefined` typed as an exporter. That exporter is `otlp`, the OpenTelemetry default (see the changeset that changes the default exporter).

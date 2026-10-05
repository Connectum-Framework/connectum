---
"@connectum/otel": minor
"@connectum/testing": patch
---

`@connectum/otel`: the OTLP/HTTP exporters no longer fail when no collector endpoint is configured.

With `OTEL_TRACES_EXPORTER=otlp/http` (or the metrics/logs equivalents) and no `OTEL_EXPORTER_OTLP_ENDPOINT`, creating the provider used to throw `Could not parse user-provided export URL: 'undefined/v1/traces'`. The exporter now falls back to its default, `http://localhost:4318/v1/<signal>`; an empty `OTEL_EXPORTER_OTLP_ENDPOINT` counts as not set. A malformed endpoint still fails at construction.

The documented OpenTelemetry environment contract is now honoured:

- `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and `OTEL_LOGS_EXPORTER` accept the standard value `otlp`. The transport follows `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL`, then `OTEL_EXPORTER_OTLP_PROTOCOL` (`grpc`, `http/protobuf`, `http/json`); with neither set it is OTLP/HTTP. `otlp/http` and `otlp/grpc` stay explicit and ignore the protocol variables.
- `OTEL_EXPORTER_OTLP_<TRACES|METRICS|LOGS>_ENDPOINT` is used as given and now takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT` for OTLP/HTTP exporters; previously the base endpoint silently won when both were set.

The OTLP/HTTP exporters send JSON for every protocol value, including `http/protobuf`.

`@connectum/testing`: `InMemoryMetricCollector` names its aggregation temporality (`AggregationTemporality.DELTA`) instead of the bare `0`, and the comment that called it CUMULATIVE is corrected. Behaviour is unchanged.

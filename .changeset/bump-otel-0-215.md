---
"@connectum/otel": patch
---

Bump OpenTelemetry SDK to 0.215.0 / v2.7.0 and semantic conventions to 1.40.0.

Highlights (auto-gain, no API changes in `@connectum/otel`):
- Hand-rolled `ProtobufLogsSerializer` (PR open-telemetry/opentelemetry-js#6390, v0.215.0) — +67–73% throughput for typical batch sizes (100–1024 logs); +72% at 512 logs, +67% at 1024 logs per upstream benchmarks in PR #6228
- `cardinalitySelector` support in `PeriodicExportingMetricReader` (PR #6460, v2.7.0) — protection against cardinality explosion on high-variance attributes
- SDK self-observability: span + log creation metrics (PRs #6213, #6433)
- Internal `mergeTwoObjects` safety checks (PR #6587, v2.7.0) — additional guards against unsafe key merges
- Updated semantic conventions (semconv v1.40.0) — stable RPC attributes including `rpc.response.status_code` and `error.type` (stabilized in semconv v1.39.0)

Breaking changes upstream that do NOT affect `@connectum/otel` (verified):
- Custom `LogRecordExporter.forceFlush()` requirement — not applicable (we use stock exporters only)
- gRPC exporter config `headers` field removal — not applicable (`CollectorOptions` has no `headers`)

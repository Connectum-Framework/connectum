---
"@connectum/otel": patch
---

Bump OpenTelemetry SDK to 0.215.0 / v2.7.0 and semantic conventions to 1.40.0.

Highlights (auto-gain, no API changes in `@connectum/otel`):
- Hand-rolled `ProtobufLogsSerializer` (PR open-telemetry/opentelemetry-js#6390, v0.215.0) — ~43% throughput improvement for protobuf log serialization
- `cardinalitySelector` support in `PeriodicExportingMetricReader` (PR #6460, v2.7.0) — protection against cardinality explosion on high-variance attributes
- SDK self-observability: span + log creation metrics (PRs #6213, #6433)
- Prototype pollution safety fix in `mergeTwoObjects` (PR #6587, v2.7.0)
- Stable RPC semantic conventions (semconv 1.28–1.30): `rpc.response.status_code`, `error.type`

Breaking changes upstream that do NOT affect `@connectum/otel` (verified):
- Custom `LogRecordExporter.forceFlush()` requirement — not applicable (we use stock exporters only)
- gRPC exporter config `headers` field removal — not applicable (`CollectorOptions` has no `headers`)

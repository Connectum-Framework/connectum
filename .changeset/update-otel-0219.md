---
"@connectum/otel": minor
---

Upgrade OpenTelemetry to `0.219.0` (experimental) / `2.8.0` (stable).

The experimental packages (`exporter-*-otlp-{grpc,http}`, `api-logs`,
`instrumentation`, `sdk-logs`, `sdk-node`, `auto-instrumentations-node`) move
from `0.215.0` to `0.219.0`, and the stable packages (`core`, `resources`,
`sdk-metrics`, `sdk-trace-node`) from `2.7.0` to `2.8.0`. The stale
`@opentelemetry/core` catalog specifier `^1.28.0` is corrected to `^2.8.0`.

This removes the duplicate `protobufjs@8.x` copy from the dependency tree:
`@opentelemetry/otlp-transformer` dropped its `protobufjs` dependency in
`0.218.0` (replaced by an in-house OTLP serializer). The OTLP wire output is
unchanged, and both OTLP/gRPC and OTLP/HTTP exporters remain exported — no
public API or behavior change. The remaining `protobufjs@7.x` copy is the
transitive `@grpc/grpc-js` dependency of the OTLP/gRPC transport, out of scope
here.

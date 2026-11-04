---
"@connectum/testing": patch
---

docs: the JSDoc of `InMemorySpanCollector`, `InMemoryMetricCollector` and `transportParityTest` now says what a scenario needs to collect the telemetry of `@connectum/otel` interceptors. Run with `OTEL_TRACES_EXPORTER=none` and `OTEL_METRICS_EXPORTER=none` (with the default exporters `@connectum/otel` records into providers of its own), and call `shutdownProvider()` at the start of every scenario (`@connectum/otel` keeps the tracer of the first registered provider, so later scenarios record nothing). Without them both legs record nothing and the comparison of two empty results passes. A parity test in `@connectum/otel` runs three scenarios in a row on this recipe and pins that each records its own spans and metrics.

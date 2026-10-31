---
"@connectum/otel": minor
---

fix: OTLP log records are exported in batches, so a burst of logs is no longer lost. The provider used to export every log record in its own request, and the OTLP exporter refuses every request above its limit of 10 concurrent exports without a retry: 100 records emitted in one tick to a collector that answers in 100 ms delivered 10, and the other 90 were dropped (the exporter reports `Concurrent export limit reached`). Logs now use the batching processor that spans already use, for `otlp/http`, `otlp/http-protobuf` and `otlp/grpc` alike, and the `console` exporter keeps printing each record at once.

Behaviour change: a log record reaches the collector up to `OTEL_BLRP_SCHEDULE_DELAY` milliseconds (1000 by default) after it is emitted, or at once when a batch fills up. Records still waiting in the queue are sent by `shutdownProvider()`. The standard variables `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` (512), `OTEL_BLRP_MAX_QUEUE_SIZE` (2048; records above it are dropped while a batch is being exported), `OTEL_BLRP_SCHEDULE_DELAY` (1000) and `OTEL_BLRP_EXPORT_TIMEOUT` (10000) tune it; an invalid value produces a process warning and the default, as for `OTEL_BSP_*`. `@opentelemetry/sdk-logs` does not read these variables itself, so the package now does, through the new exported `getBatchLogRecordProcessorOptions()` and `BatchLogRecordProcessorOptions`.

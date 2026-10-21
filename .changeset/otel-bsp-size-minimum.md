---
"@connectum/otel": patch
---

fix: `OTEL_BSP_MAX_QUEUE_SIZE=0` and `OTEL_BSP_MAX_EXPORT_BATCH_SIZE=0` are now treated as invalid, like a non-integer: the process warning (`CONNECTUM_OTEL_INVALID_ENV`) names the variable and the default (1000 and 100) is used. With the OpenTelemetry batch span processor a queue of size 0 dropped every span without any trace, and a batch of size 0 made the process allocate until it ran out of memory (both measured with `@opentelemetry/sdk-trace-node`). `OTEL_BSP_SCHEDULE_DELAY` and `OTEL_BSP_EXPORT_TIMEOUT` still accept 0.

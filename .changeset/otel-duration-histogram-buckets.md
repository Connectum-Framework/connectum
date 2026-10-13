---
"@connectum/otel": minor
---

fix: `rpc.server.call.duration` and `rpc.client.call.duration` are created with the explicit bucket boundaries the OpenTelemetry RPC metrics specification recommends (`0.005 ... 10` seconds), exported as `RPC_DURATION_BUCKETS`. The SDK default boundaries are a millisecond scale (`0, 5, 10, 25, ... 10000`), so every duration recorded in seconds fell into the first bucket and percentiles computed from the histogram were meaningless.

**BREAKING** for consumers of the exported series only: the `le` bucket edges of these two histograms change, so dashboards and alerts that reference the old edges must be updated. Released in a minor version, as the other behaviour corrections of 1.3. Connectum's own provider accepts no views; to use other boundaries, set `OTEL_METRICS_EXPORTER=none`, register your own `MeterProvider` with a `View` on `rpc.server.call.duration` / `rpc.client.call.duration`, and the instruments take the view's boundaries (the metrics guide shows how).

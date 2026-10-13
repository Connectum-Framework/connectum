---
"@connectum/otel": minor
---

fix: `rpc.server.call.duration` and `rpc.client.call.duration` are created with the explicit bucket boundaries the OpenTelemetry RPC metrics specification recommends (`0.005 ... 10` seconds), exported as `RPC_DURATION_BUCKETS`. The SDK default boundaries are a millisecond scale (`0, 5, 10, 25, ... 10000`), so every duration recorded in seconds fell into the first bucket and percentiles computed from the histogram were meaningless.

**BREAKING** for consumers of the exported series only: the `le` bucket edges of these two histograms change, so dashboards and alerts that reference the old edges must be updated. Shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0. An application `View` still overrides the boundaries.

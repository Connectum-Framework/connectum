---
"@connectum/otel": minor
---

fix: `@connectum/otel` no longer sets span status `OK` on success; the status stays unset (UNSET) and `ERROR` is the only status the package sets. The OpenTelemetry Trace API says instrumentation libraries SHOULD NOT set `OK`, and the RPC semantic conventions require the status to be left unset when a call succeeds; `otelconnect-go`, `otelgrpc` and the Node gRPC instrumentation do the same, so Connectum spans now read like the rest of a mixed-vendor trace. This covers server and client calls (`createOtelInterceptor`, `createOtelClientInterceptor`), streams (including a catalog client-streaming call), and the `traced` and `traceAll` wrappers. A stream whose consumer stops early (`return()` or `break`) also ends unset: it is neither a failure nor a confirmed success.

**BREAKING** for anything that selects spans by `status = ok` (trace queries, dashboards, alert rules, sampling rules in a collector). Shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0. A missing status no longer says whether a call succeeded: count errors by `status = error` (the package still sets `ERROR` with the error message on a failure or a cancellation), count calls without an error as "status is not error" (this includes a stream whose consumer stopped early, which is neither a failure nor a confirmed success), and for confirmed successes filter on the `rpc.response.status_code` attribute, which still reports `OK` for a successful unary call. OpenTelemetry keeps `UNSET` and `OK` distinct, so do not read `UNSET` as `OK`. Nothing else changes: `rpc.response.status_code`, `error.type`, the metrics and the span events are as before.

The code of a canceled call is spelled `CANCELED` (one L, as the Connect protocol, Connect-ES, connect-go and `otelconnect-go` write it); `CANCELLED` is the gRPC spelling and is never produced. A query over data from both stacks can match both with `CANCEL+ED`.

**Migration**

- Replace `status = ok` filters with `status != error` when you mean "calls without an error"; use the `rpc.response.status_code` attribute when you need confirmed successes.
- Replace "spans with status OK" counts used as a success rate with `rpc.response.status_code = "OK"` over all calls. `1 - error spans / all spans` is a non-error rate: it also counts streams that a consumer stopped early.
- If a backend renders unset status as "unknown", that is the specified meaning of the unset state; the error state is what the package sets on failure.

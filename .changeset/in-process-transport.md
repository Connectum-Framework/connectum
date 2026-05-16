---
"@connectum/core": minor
"@connectum/testing": minor
"@connectum/otel": minor
---

Add in-process transport with automatic local/remote routing via service registry.

**`@connectum/core`** — new public API for in-process service invocation:

- `createLocalTransport(server, options?)` — ConnectRPC `Transport` bound to the server's router; supports client-side interceptors.
- `server.client(service, options?)` — auto-routing client factory: in-process if `service` is registered on this server, else `options.fallback`, else fail-fast `ConnectError(unimplemented)`.
- `server.localClient(service)` — low-level helper that always returns an in-process client.
- `server.hasService(desc)` — synchronous service registry lookup by `desc.typeName`.

The in-process transport runs the full server-side interceptor chain (validation, authorization, OpenTelemetry), supports unary and all streaming RPCs, propagates `Headers` and `AbortSignal`, and preserves 1-to-1 behavioural parity with the HTTP/gRPC transport. Strictly additive — no breaking changes.

**`@connectum/testing`** — helpers for cross-transport testing:

- `createLocalClient(server, service)` — concise client for unit and integration tests without binding ports.
- `transportParityTest(name, scenario)` — driver that runs one declarative scenario against both `createGrpcTransport` and `createLocalTransport`, structurally diffs the observable outcome (response, headers, `ConnectError`, OTEL spans, metrics), and fails on any divergence.
- In-memory OTEL `SpanExporter` and `MetricReader` collectors used by the parity driver.

**`@connectum/otel`** — observability parity for the in-process path:

- `connectum.transport` span attribute (`in-process` | `http`) on both CLIENT and SERVER spans.
- `transport` metric label on `rpc.client.duration`, `rpc.server.duration`, payload size, and error counter instruments.
- W3C Trace Context (`traceparent` / `tracestate`) propagation through in-memory `Headers` so server spans are children of client spans on both transports.

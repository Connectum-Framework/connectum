# @connectum/otel

This README documents `@connectum/otel` 1.3 and later.

OpenTelemetry instrumentation for ConnectRPC services, with tracing, metrics,
structured logging, and provider configuration.

## Install

```bash
pnpm add @connectum/otel
```

The package requires Node.js `>=22.13.0`. OpenTelemetry APIs, SDKs, and
exporters are regular dependencies; `@opentelemetry/api` stays on `>=1.9.0 <1.10.0`,
the range that the SDK packages used here accept. Peer dependencies are
`@bufbuild/protobuf` `^2.16.0` and `@connectrpc/connect` `^2.2.0`; share these
with the rest of the application. See
[peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Prerequisite: use the public
[`examples/getting-started`](https://github.com/Connectum-Framework/examples/tree/main/getting-started)
project. Replace its `src/server.ts` with this version, then run `pnpm start`;
the script runs `buf generate` before starting the app. The snippet initializes
the provider and registers its shutdown through the server's awaited shutdown
hooks, so telemetry is flushed during graceful shutdown. The example requires
Node.js `>=25.2.0` in its default mode.

```typescript
import { createServer } from '@connectum/core';
import type { Server } from '@connectum/core';
import { Healthcheck } from '@connectum/healthcheck';
import { createDefaultInterceptors, createErrorHandlerInterceptor } from '@connectum/interceptors';
import { Reflection } from '@connectum/reflection';
import { createOtelInterceptor, initProvider, shutdownProvider } from '@connectum/otel';
import { greeterService } from '#services/greeterService.ts';

export function buildServer(port = 5000, autoShutdown = false): Server {
  initProvider({ serviceName: 'getting-started' });
  const server = createServer({
    services: [greeterService],
    port,
    allowHTTP1: false,
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: [
      createErrorHandlerInterceptor(),
      createOtelInterceptor(),
      ...createDefaultInterceptors({ errorHandler: false }),
    ],
    shutdown: { autoShutdown, timeout: 10_000 },
  });
  server.onShutdown(shutdownProvider);
  return server;
}
```

## Default exporter

With no `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER`
set, each signal is sent over OTLP/HTTP with a protobuf body to
`http://localhost:4318`, as the OpenTelemetry specification requires. Nothing is
printed. Set the variable to `console` to print a signal to standard output, or
to `none` to switch it off. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your
collector.

If nothing listens at the endpoint, calls are not affected and the exporter
reports each distinct failure on standard error at most once a minute.
`shutdownProvider()` then rejects once the exporters give up (measured: about
8 seconds with the default settings; pass `{ timeout }` to bound it). Registered
with `server.onShutdown()`, the rejection does not end the process.

## Log batching

Log records sent over OTLP (HTTP or gRPC) are queued and exported in batches, as
spans are: a batch leaves when it is full or after `OTEL_BLRP_SCHEDULE_DELAY`
milliseconds (1000 by default), so a record reaches the collector up to that long
after it is emitted. `shutdownProvider()` sends the records still in the queue.
The `console` exporter prints each record at once. Tune the queue with the
standard variables `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` (512),
`OTEL_BLRP_MAX_QUEUE_SIZE` (2048), `OTEL_BLRP_SCHEDULE_DELAY` (1000) and
`OTEL_BLRP_EXPORT_TIMEOUT` (10000). Records that arrive while the queue is full
and a batch is being exported are dropped; an invalid value produces a process
warning and the default.

## Limitations

- Set `recordMessages: true` to add per-message events to streaming spans; the
  option is disabled by default. `rpc.message.uncompressed_size` is the
  serialized size of each individual message, not the total stream size. Events
  contain metadata and size, not message payloads. The aggregate size histograms
  of a streaming call stay zero.
- The instrumentation captures the active span when creating a stream because
  Node.js `AsyncLocalStorage` context can be lost across async-generator
  boundaries. See the [observability guide](https://connectum.dev/en/guide/observability).

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/otel)
- [Configure exporters and batching](https://connectum.dev/en/guide/observability/backends)
- [API reference](https://connectum.dev/en/api/@connectum/otel/)
- Contributors updating OpenTelemetry dependencies should follow the
  [workspace catalog instructions](https://connectum.dev/en/contributing/development-setup#upgrading-opentelemetry-dependencies).

## License

Apache-2.0

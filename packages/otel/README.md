# @connectum/otel

This README describes the 1.3.x source; that release is not yet published to npm.

OpenTelemetry instrumentation for ConnectRPC services, with tracing, metrics,
structured logging, and provider configuration.

## Install

```bash
pnpm add @connectum/otel
```

The package requires Node.js `>=22.13.0`. OpenTelemetry APIs, SDKs, and
exporters are regular dependencies. Peer dependencies are
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

## Limitations

- Set `recordMessages: true` to add per-message events to streaming spans; the
  option is disabled by default. The message size attribute is an estimate for
  each individual message, not the total stream size. Events contain metadata
  and estimated size, not serialized message payloads.
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

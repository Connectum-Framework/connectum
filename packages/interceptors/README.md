# @connectum/interceptors

This README describes the 1.3.x source; that release is not yet published to npm.

ConnectRPC interceptors for error normalization, validation, request limits,
resilience, logging, and protobuf JSON serialization.

## Install

```bash
pnpm add @connectum/interceptors
```

The package requires Node.js `>=22.13.0`. Peer dependencies are
`@connectum/core`, `@bufbuild/protobuf` `^2.16.0`, and
`@connectrpc/connect` `^2.2.0`. The validation engine is a regular
dependency. See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Prerequisite: use the public
[`examples/getting-started`](https://github.com/Connectum-Framework/examples/tree/main/getting-started)
project. Its `src/services/greeterService.ts` implements a real service and
`src/index.ts` starts the `buildServer` exported by `src/server.ts`. Replace
that server file with this version after installing the package,
then run `pnpm start`; it runs `buf generate` before starting the app. The
example requires Node.js `>=25.2.0` by default.

```typescript
import { createServer } from '@connectum/core';
import type { Server } from '@connectum/core';
import { createDefaultInterceptors } from '@connectum/interceptors';
import { greeterService } from '#services/greeterService.ts';

export function buildServer(port = 5000, autoShutdown = false): Server {
  return createServer({
    services: [greeterService],
    port,
    allowHTTP1: false,
    interceptors: createDefaultInterceptors(),
    shutdown: { autoShutdown, timeout: 10_000 },
  });
}
```

## Constraints

- The default chain enables only error handling and validation.
  Timeout, bulkhead, circuit breaker, and retry behavior are opt-in.
- The circuit breaker is intended for outbound calls to an upstream service.
- In the upcoming 1.3.x source, request and response bodies are omitted from
  logger output by default. See the [logger migration note](https://connectum.dev/en/migration/logger-bodies).

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/interceptors)
- [Built-in interceptors](https://connectum.dev/en/guide/interceptors/built-in)
- [Creating custom interceptors](https://connectum.dev/en/guide/interceptors/custom)
- [API reference](https://connectum.dev/en/api/@connectum/interceptors/)

## License

Apache-2.0

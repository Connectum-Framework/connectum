# @connectum/core

This README documents `@connectum/core` 1.3 and later.

Server foundation for ConnectRPC services. `createServer()` composes service
routes, protocol plugins, interceptors, transport, and shutdown behavior.

## Install

```bash
pnpm add @connectum/core
```

The package requires Node.js `>=22.13.0`. Peer dependencies are
`@bufbuild/protobuf` `^2.16.0`, `@connectrpc/connect` `^2.2.0`, and
`@connectrpc/connect-node` `^2.2.0`. Keep `connect` and `connect-node` on
compatible versions and share the same protobuf and Connect copies across
Connectum packages. Package managers handle peer installation differently;
see [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Prerequisite: use the public
[`examples/getting-started`](https://github.com/Connectum-Framework/examples/tree/main/getting-started)
project. Its `src/services/greeterService.ts` implements a real service and
`src/index.ts` starts the `buildServer` exported by `src/server.ts`. After
installing the released package version, replace that server file with this
version, then run `pnpm start`; the script runs
`buf generate` before starting the app. The example requires Node.js
`>=25.2.0` in its default mode.

```typescript
import { createServer } from '@connectum/core';
import type { Server } from '@connectum/core';
import { greeterService } from '#services/greeterService.ts';

export function buildServer(port = 5000, autoShutdown = false): Server {
  return createServer({
    services: [greeterService],
    port,
    allowHTTP1: false,
    shutdown: { autoShutdown, timeout: 10_000 },
  });
}
```

Install protocol and interceptor packages separately when needed. For example,
`@connectum/healthcheck` provides gRPC health checks and optional HTTP endpoints;
`@connectum/reflection` provides gRPC Server Reflection.

## Constraints

- `@connectum/core` is published as compiled JavaScript. Running application
  TypeScript directly has separate Node.js or `tsx` requirements; see
  [runtime compatibility](https://connectum.dev/en/guide/runtime-compatibility).
- The runtime checks the loaded peer versions when `createServer()` is called. The
  check cannot read package metadata when the package is bundled into the
  application. See [peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).
- Use [request admission](https://connectum.dev/en/guide/security/request-admission)
  when a server must reject requests before reading their bodies.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/core)
- [Server guide](https://connectum.dev/en/guide/server)
- [Configuration and TLS](https://connectum.dev/en/guide/server/configuration)
- [API reference](https://connectum.dev/en/api/@connectum/core/)

## License

Apache-2.0

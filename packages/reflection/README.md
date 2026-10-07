# @connectum/reflection

This README describes the 1.3.x source; that release is not yet published to npm.

gRPC Server Reflection v1 and v1alpha protocol plugin for Connectum. Reflection
lets compatible clients discover mounted services and their protobuf schemas.

## Install

```bash
pnpm add @connectum/reflection
```

The package requires Node.js `>=22.13.0`. Peer dependencies are
`@connectum/core`, `@bufbuild/protobuf` `^2.16.0`, and
`@connectrpc/connect` `^2.2.0`. See
[peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

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
import { Healthcheck } from '@connectum/healthcheck';
import { createDefaultInterceptors } from '@connectum/interceptors';
import { Reflection } from '@connectum/reflection';
import { greeterService } from '#services/greeterService.ts';

export function buildServer(port = 5000, autoShutdown = false): Server {
  return createServer({
    services: [greeterService],
    port,
    allowHTTP1: false,
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: createDefaultInterceptors(),
    shutdown: { autoShutdown, timeout: 10_000 },
  });
}
```

With a compatible client and a reachable plaintext HTTP/2 server, inspect its
services with:

```bash
grpcurl -plaintext localhost:5000 list
buf curl --protocol grpc --http2-prior-knowledge http://localhost:5000 --list-methods
```

## Constraints

- Enabling reflection exposes mounted service names and schemas to clients that
  can reach the server. Restrict network access where that information must
  remain private.
- `grpcurl` and `buf` are external tools; they are not installed by this package.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/reflection)
- [Server Reflection guide](https://connectum.dev/en/guide/protocols/reflection)
- [API reference](https://connectum.dev/en/api/@connectum/reflection/)

## License

Apache-2.0

# @connectum/healthcheck

This README documents `@connectum/healthcheck` 1.3 and later.

Implements the gRPC Health Checking Protocol and optional HTTP health endpoints
for Connectum servers.

## Install

```bash
pnpm add @connectum/healthcheck
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

## Constraints

- HTTP health routes are disabled unless `httpEnabled` is set.
- `healthcheckManager.update()` without a service name changes the status of all
  registered services and components.
  Use a dedicated manager when separate servers or components need independent
  status.
- `update()`, `register()` and `set()` accept only the four `ServingStatus`
  values (0 to 3) and string names. Anything else throws `TypeError` or
  `RangeError` and leaves the registry unchanged.
- `watchInterval` must be an integer from 1 to 2147483647 milliseconds;
  `Healthcheck()` throws otherwise.
- `Healthcheck()` throws when `options` is `null`, `manager` is not a
  `HealthcheckManager` or `httpEnabled` is not a boolean. Register it once per
  server: a second `Healthcheck()` (or your own `grpc.health.v1.Health`
  service) makes `start()` reject, because only one registration may answer.
- `Health.Check` answers `NOT_FOUND` for an unknown service. The message repeats
  at most the first 128 characters of the requested name.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/healthcheck)
- [Health checks guide](https://connectum.dev/en/guide/health-checks/protocol)
- [Kubernetes probes](https://connectum.dev/en/guide/health-checks/kubernetes)
- [API reference](https://connectum.dev/en/api/@connectum/healthcheck/)

## License

Apache-2.0

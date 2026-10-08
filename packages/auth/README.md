# @connectum/auth

This README documents `@connectum/auth` 1.3 and later.

Authentication and authorization interceptors for ConnectRPC. The package
supports JWT verification, gateway and session credentials, service-to-service
trust, proto-declared authorization, and auth-context propagation.

## Install

```bash
pnpm add @connectum/auth
```

The package requires Node.js `>=22.13.0`. Its peer dependencies are
`@connectum/core`, `@bufbuild/protobuf` `^2.16.0`, and
`@connectrpc/connect` `^2.2.0`. See
[peer dependency guidance](https://connectum.dev/en/migration/peer-dependencies).

## Start here

Prerequisite: start from the public
[`examples/getting-started`](https://github.com/Connectum-Framework/examples/tree/main/getting-started)
project and use its implemented `#services/greeterService.ts`. Install its
dependencies and add `@connectum/auth`, then replace `src/server.ts`
with this version, and set `JWKS_URI` and `JWT_ISSUER` for your token provider.
Follow the [JWT setup guide](https://connectum.dev/en/guide/auth/jwt) for token
issuer and key configuration. The example project uses Node.js `>=25.2.0` in
its default mode. Tokens for this example must include a subject and the
`my-api` audience configured below.

```typescript
import { createServer } from '@connectum/core';
import type { Server } from '@connectum/core';
import { Healthcheck } from '@connectum/healthcheck';
import { createDefaultInterceptors, createErrorHandlerInterceptor } from '@connectum/interceptors';
import { Reflection } from '@connectum/reflection';
import { createJwtAuthInterceptor } from '@connectum/auth';
import { greeterService } from '#services/greeterService.ts';

export function buildServer(port = 5000, autoShutdown = false): Server {
  return createServer({
    services: [greeterService],
    port,
    allowHTTP1: false,
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: [
      createErrorHandlerInterceptor(),
      createJwtAuthInterceptor({
        jwksUri: process.env.JWKS_URI!,
        issuer: process.env.JWT_ISSUER!,
        audience: 'my-api',
      }),
      ...createDefaultInterceptors({ errorHandler: false }),
    ],
    shutdown: { autoShutdown, timeout: 10_000 },
  });
}
```

Handlers can read the verified identity with `requireAuthContext()` from
`@connectum/auth`.

## Security constraints

- `createJwtAuthInterceptor` rejects a token without `sub` unless
  `claimsMapping.subject` supplies the identity.
- The generic and session interceptors accept `propagatedClaims` to limit the
  claim keys forwarded in `x-auth-claims` headers when propagation is enabled.
- `createJwtAuthInterceptor` checks its HMAC secret's minimum byte length
  against configured algorithms: 32 for HS256, 48 for HS384, and 64 for HS512;
  when algorithms are omitted, its minimum is 32 bytes.
- The generic, JWT, and session interceptors strip the standard Connectum auth
  headers before setting verified auth
  context. Header values for roles, scopes, and claims are bounded; oversized
  values are omitted.

For gateway and service-to-service trust boundaries, see the
[authentication guide](https://connectum.dev/en/guide/auth) and the
[authorization guide](https://connectum.dev/en/guide/auth/authorization).

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/auth)
- [Configure JWT authentication](https://connectum.dev/en/guide/auth/jwt)
- [Configure session authentication](https://connectum.dev/en/guide/auth/session)
- [API reference: JWT options](https://connectum.dev/en/api/@connectum/auth/interfaces/JwtAuthInterceptorOptions)

## License

Apache-2.0

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
        skipMethods: ['grpc.health.v1.Health/*'],
      }),
      ...createDefaultInterceptors({ errorHandler: false }),
    ],
    shutdown: { autoShutdown, timeout: 10_000 },
  });
}
```

Health and reflection methods are not skipped automatically: `skipMethods`
above leaves the gRPC health service open for probes, while reflection and the
greeter still require a token. The HTTP `/healthz` endpoint
answers without a token.

Handlers can read the verified identity with `requireAuthContext()` from
`@connectum/auth`. For a streaming call the identity stays available to the
handler for the whole call, including after its first `await` or `yield`.

## Security constraints

- `createJwtAuthInterceptor` rejects a token without `sub` unless
  `claimsMapping.subject` supplies the identity.
- `createGatewayAuthInterceptor` trusts a shared secret in `trustSource`. A CIDR
  block in `expectedValues` is matched against a header the caller chooses, so
  creating the interceptor with one throws unless `allowCallerControlledCidr: true`
  is set.
- `verifyCredentials` and `mapSession` must return a complete `AuthContext`;
  `null`, `undefined`, `false`, `{}` or a result with a missing or mistyped
  field (`roles` and `scopes` must be arrays of at most 8192 strings, without
  holes) ends the call with `Unauthenticated`, with or without `propagateHeaders`,
  and is never cached. So does a result that passes that check but cannot be
  copied for the cache or written into headers (a throwing getter, a proxy whose
  trap throws, a cyclic or `BigInt` claim, a throwing `toJSON`).
- The generic and session interceptors accept `propagatedClaims` to limit the
  claim keys forwarded in `x-auth-claims` headers when propagation is enabled.
- `createJwtAuthInterceptor` checks its HMAC secret's minimum byte length
  against configured algorithms: 32 for HS256, 48 for HS384, and 64 for HS512;
  when algorithms are omitted, its minimum is 32 bytes.
- `skipMethods` does not accept the catch-all pattern `"*"` (creating the
  interceptor throws); list `Service/*` patterns, or do not register the
  interceptor. A cache `ttl` must be finite and greater than 0 and `maxSize` an
  integer of at least 1.
- With `propagateHeaders`, a subject, type, name, or scope that contains NUL, CR,
  LF, or a lone surrogate, and a scope that is empty or contains a space (the
  reader splits scopes on spaces and drops empty pieces), is rejected with `Unauthenticated` before it is cached.
  Roles and claims are written as JSON with `\uXXXX` escapes for characters above
  U+00FF and read back as the parsed JSON.
- With the `cache` option of the generic and session interceptors, every request
  gets its own copy of the cached identity. `roles`, `scopes`, `expiresAt` and
  nested plain objects, arrays and dates in `claims` are copied; other values in
  `claims` (a `Map`, a class instance) are shared. A handler that changes its
  copy does not change what a later request with the same credential receives.
- The generic, JWT, and session interceptors strip the standard Connectum auth
  headers (the names in `AUTH_HEADERS`) before setting verified auth
  context. The gateway interceptor strips them too, after it has read its own
  mapped input, so a client-supplied value of one of those headers is not
  forwarded to the next hop.
- With `propagateHeaders`, text above U+00FF in a subject, type, name, or scope
  (Cyrillic, CJK, emoji) is written as `utf-8''` plus percent-encoded UTF-8 and
  read back by the receiver (the writer sets `x-auth-encoding: percent-utf8`,
  and readers decode only when it is present). ASCII and Latin-1 text is written
  as is, with two exceptions that are encoded too: a text that starts with
  `utf-8''` (readers decode that prefix when the marker is present), and a text
  with a space or tab at either end (`Headers.set` would otherwise remove that
  whitespace). A subject over 512 characters, a type over 128, a name over 256,
  or roles, scopes, or claims whose serialized value is over 8192 characters is
  rejected with `Unauthenticated` instead of being cut or left out.

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

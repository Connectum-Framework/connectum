# @connectum/interceptors

This README documents `@connectum/interceptors` 1.3 and later.

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

- The default chain enables only error handling and validation.
  Timeout, bulkhead, circuit breaker, and retry behavior are opt-in.
- The circuit breaker is intended for outbound calls to an upstream service.
- Since 1.3, request and response bodies are omitted from
  logger output by default. See the [logger migration note](https://connectum.dev/en/migration/logger-bodies).

## Cancellation behavior in 1.3

Timeout now forwards its own deadline and caller cancellation to downstream
work. Retry interrupts backoff, avoids future attempts after cancellation and
rejects a late success from cancelled work. Callers that previously observed a
late successful response or an extra retry must now handle cancellation errors.
Observe `req.signal` in custom interceptors and `ctx.signal` in RPC handlers,
and pass it to cancellable I/O. Unaware work can still finish and commit side
effects, so cancellation is not a rollback.

Timeout's own deadline returns `DeadlineExceeded`. Caller cancellation preserves
an existing caller `ConnectError`, including its code and metadata/details; other
caller reasons become `Canceled`. The first cancellation cause wins. With
`skipStreaming: false` the timeout and retry cover opening the streaming
response; caller cancellation still reaches an opened stream.

**Timeout and circuit breaker.** In the default order the timeout is outside the
circuit breaker, which wraps retry. An expired timeout aborts the inner chain
with a `DeadlineExceeded` error, so the breaker now records it as a failure:
`DeadlineExceeded` is one of the codes counted by the default failure predicate.
Repeated timeouts of a cooperative handler open the circuit. Before, the breaker
never saw the timeout itself, only whatever the abandoned handler eventually
returned. For a handler that ignores the signal the failure is recorded when that
handler settles, not when the caller gets its deadline error, and only because
retry converts the late result into the cancellation error. Caller cancellation
with the default `Canceled` code is not counted; a caller `ConnectError` reason
with an infrastructure code such as `Unavailable` is counted under its own code.
To keep timeouts from tripping the breaker, exclude `DeadlineExceeded` in
`failurePredicate`; see the
[circuit breaker guide](https://connectum.dev/en/guide/interceptors/built-in#circuit-breaker-placement-and-error-classification).

Options, defaults and chain order are unchanged.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/interceptors)
- [Built-in interceptors](https://connectum.dev/en/guide/interceptors/built-in)
- [Creating custom interceptors](https://connectum.dev/en/guide/interceptors/custom)
- [API reference](https://connectum.dev/en/api/@connectum/interceptors/)

## License

Apache-2.0

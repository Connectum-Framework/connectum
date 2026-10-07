# @connectum/test-fixtures

This README describes the 1.3.x source; that release is not yet published to npm.

Lightweight mock factories, assertion helpers, and protobuf descriptor fixtures
shared across `@connectum/*` test suites.

This package is **transport-free** — it has no dependency on
`@connectum/core`, `@connectum/interceptors`, or any other Connectum package.
This keeps the workspace dependency graph acyclic and lets every Connectum
package depend on it without introducing build cycles.

**Peer dependencies:** `@bufbuild/protobuf` `^2.16.0` and `@connectrpc/connect`
`^2.2.0`, so the fixtures build descriptors and errors from the same copies your
code uses.

`@connectum/testing` re-exports these low-level helpers and adds a test server,
in-process clients, telemetry collectors, and cross-transport parity tests.

Most application tests should depend on `@connectum/testing`. Install
`@connectum/test-fixtures` directly only when its low-level factories or
descriptor fixtures are needed:

```bash
pnpm add -D @connectum/test-fixtures
```

## Start here

Create a request and a spy for an interceptor test:

```javascript
import { createMockNext, createMockRequest } from '@connectum/test-fixtures';

const request = createMockRequest({ service: 'acme.UserService', method: 'GetUser' });
const next = createMockNext({ message: { id: 'user-1' } });
const response = await next(request);

console.log(response.message.id); // user-1
console.log(next.mock.calls.length); // 1
```

Save this as `fixture-example.mjs` and run `node fixture-example.mjs`.
In an interceptor test, pass `next` and `request` to the interceptor, then
inspect the response and recorded calls. These factories use simplified
descriptors; use a test server when a test needs transport behavior.

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/test-fixtures)
- [Testing guide](https://connectum.dev/en/guide/testing)
- [API reference](https://connectum.dev/en/api/@connectum/test-fixtures/)

## License

Apache-2.0

---

**Part of [Connectum](../../README.md).**

# @connectum/test-fixtures

Lightweight mock factories, assertion helpers, and protobuf descriptor fixtures
shared across `@connectum/*` test suites.

This package is **transport-free** — it has no dependency on
`@connectum/core`, `@connectum/interceptors`, or any other Connectum package.
This keeps the workspace dependency graph acyclic and lets every Connectum
package depend on it without introducing build cycles.

## What lives here

- `assertConnectError` — assertion helper for `ConnectError` thrown values
- `createMockFn` — portable `node:test`-free spy factory
- `createMockRequest` — fake unary ConnectRPC request
- `createMockNext`, `createMockNextError`, `createMockNextSlow` — fake `next` handlers
- `createMockStream` — async iterable for streaming tests
- `createMockDescMessage`, `createMockDescField`, `createMockDescMethod` — protobuf descriptor mocks
- `createFakeService`, `createFakeMethod` — generic `DescService`/`DescMethod` fixtures

For higher-level utilities (test server, in-process transport, OTel collectors,
cross-transport parity driver) see `@connectum/testing`.

## Compat re-export

`@connectum/testing` re-exports every symbol from this package, so existing
imports from `@connectum/testing` continue to work unchanged.

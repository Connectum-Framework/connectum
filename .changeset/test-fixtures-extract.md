---
"@connectum/test-fixtures": minor
"@connectum/testing": minor
"@connectum/interceptors": patch
---

Extract mock factories, assertion helpers, and protobuf descriptor fixtures
from `@connectum/testing` into a new transport-free package
`@connectum/test-fixtures`.

**Why**: `@connectum/interceptors` depended on `@connectum/testing` in
devDependencies for its unit tests (via `assertConnectError`, `createMockNext*`,
`createMockRequest`), while `@connectum/testing` depended on
`@connectum/interceptors` for parity tests — creating a workspace build cycle
that broke `turbo build` and forced `pack-all.sh` to fall back to
`pnpm -r --workspace-concurrency=1`.

**What moved** (from `@connectum/testing` → `@connectum/test-fixtures`):
- `assertConnectError`
- `createMockFn`, `MockCall`, `MockFn`
- `createMockRequest`, `createMockNext`, `createMockNextError`, `createMockNextSlow`
- `createMockStream`
- `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`
- `createFakeService`, `createFakeMethod`
- All mock/fixture option types (`MockRequestOptions`, `MockNextOptions`, etc.)

**Backwards compatible**: all the above symbols are re-exported from
`@connectum/testing` so existing imports continue to work unchanged. The
parity driver, in-process transport helper, test server, and OTel collectors
remain in `@connectum/testing`.

**Internal**: `@connectum/interceptors` now depends on
`@connectum/test-fixtures` in devDependencies instead of `@connectum/testing`.
Its public API is unchanged.

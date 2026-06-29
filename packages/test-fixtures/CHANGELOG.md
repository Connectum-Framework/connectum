# @connectum/test-fixtures

## 1.2.0

## 1.1.0

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

## 1.0.0

### Minor Changes

- [#117](https://github.com/Connectum-Framework/connectum/pull/117) [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e) Thanks [@intech](https://github.com/intech)! - Extract mock factories, assertion helpers, and protobuf descriptor fixtures
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

### Patch Changes

- [#151](https://github.com/Connectum-Framework/connectum/pull/151) [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4) Thanks [@intech](https://github.com/intech)! - chore(deps): bump in-range production dependencies

  Raise the lower bounds of catalog-managed production dependencies within their
  existing `^` ranges (minor/patch, no breaking changes). On publish, pnpm rewrites
  each `catalog:` specifier to the concrete range, so raising the floor changes the
  dependency contract surfaced to consumers — hence a patch bump.

  - `@connectrpc/connect` `^2.1.1 → ^2.1.2`
  - `@connectrpc/connect-node` `^2.1.1 → ^2.1.2`
  - `@bufbuild/protobuf` `^2.11.0 → ^2.12.0`
  - `zod` `^4.3.6 → ^4.4.3`

  Affected packages (production `dependencies` referencing the above via `catalog:`):
  auth, cli, core, events, healthcheck, interceptors, otel, reflection,
  test-fixtures, testing. Build, typecheck, lint, unit/integration tests, the
  Bun/esbuild cross-runtime suites, and the HTTP ↔ in-process parity gate all pass
  with no behavioural changes (including ConnectRPC cancellation and unary-GET
  query handling paths).

  Dev-only tooling bumps in the same change (not part of the published dependency
  contract, so no version impact): `@biomejs/biome`, `@bufbuild/buf`,
  `@bufbuild/protoc-gen-es`, `@bufbuild/protovalidate`, `tsup`, `@types/node`.

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

- [#158](https://github.com/Connectum-Framework/connectum/pull/158) [`6201cf2`](https://github.com/Connectum-Framework/connectum/commit/6201cf2ea269e247d2a4366dff6387deec73e3d8) Thanks [@intech](https://github.com/intech)! - fix: bound the matched input in `assertConnectError`; align `engines.node`

  `assertConnectError` now matches `messagePattern` against a 1000-char slice of the error message rather than the full string. The function already failed fast on messages longer than 1000 chars; making the bound explicit at the match site is a bounded-input mitigation (it caps the matched length, not regex complexity — the pattern is test-author controlled, not attacker input) and clears the `js/polynomial-redos` static-analysis finding. Also aligns `@connectum/test-fixtures` `engines.node` to the published consumer floor (`>=22.13.0`, was `>=20.0.0`) for consistency with the other packages.

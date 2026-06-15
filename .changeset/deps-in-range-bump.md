---
"@connectum/auth": patch
"@connectum/cli": patch
"@connectum/core": patch
"@connectum/events": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
"@connectum/otel": patch
"@connectum/reflection": patch
"@connectum/test-fixtures": patch
"@connectum/testing": patch
---

chore(deps): bump in-range production dependencies

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

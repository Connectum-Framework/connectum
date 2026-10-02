# @connectum/cli

## 1.3.0

### Minor Changes

- [#284](https://github.com/Connectum-Framework/connectum/pull/284) [`b85184a`](https://github.com/Connectum-Framework/connectum/commit/b85184a1b3cd61833e52c8c8aabd880ee4b1f85b) Thanks [@intech](https://github.com/intech)! - Generated code can import Connectum's option descriptors from the packages, and `connectum init` no longer generates its own copies.
  
  - `@connectum/auth` exports `./gen/connectum/auth/v1/options_pb.js` (`file_connectum_auth_v1_options`, `method_auth`, `service_auth`, the `MethodAuth` / `ServiceAuth` / `AuthRequirements` schemas and types), and `@connectum/events` exports `./gen/connectum/events/v1/options_pb.js` (`file_connectum_events_v1_options`, `event`, the `EventOptions` schema and type). Each subpath is the module the package itself uses, so a package evaluates its option proto once and hands out the same descriptor objects through every entry. Point protoc-gen-es (2.15.0 or later) at them with `map_imports=connectum/auth/v1/:@connectum/auth/gen` / `map_imports=connectum/events/v1/:@connectum/events/gen`. `@connectum/events` is now built with code splitting, so its `dist/index.js` imports a shared chunk.
  - `connectum init --auth` / `--events`: the generated `buf.gen.yaml` compiles Connectum's option protos without generating them (one `directory: proto` input, the vendored events option proto under `exclude_paths`) and maps their imports to the packages, so `gen/` no longer holds `connectum/{auth,events}/v1/options_pb.ts`. Every `@connectum/*` dependency of such a project is set to one range: the highest `@connectum/*` requirement of the fetched base, or `^1.3.0` if that is higher (also with `--ref`), so no base entry is lowered. Projects without auth or events are generated exactly as before. Existing projects keep working unchanged.

- [#229](https://github.com/Connectum-Framework/connectum/pull/229) [`8ed62cf`](https://github.com/Connectum-Framework/connectum/commit/8ed62cfaaf96cb2f08cadf3db9d0ab9c1b70b236) Thanks [@intech](https://github.com/intech)! - feat: `connectum init` and `connectum generate service` — project scaffolding
  
  - **`connectum init`** scaffolds a production-ready standalone project, interactively (a `@clack/prompts` wizard) or fully from flags (`--yes` / CI / non-TTY). The base is fetched from the dogfooded `getting-started` example via a degit-style clone, so the starter layout stays in sync with a tested example instead of a drift-prone template copy; the selected modules are composed on top.
  - **Modules:** OpenTelemetry (`--otel`), EventBus with an adapter (`--events nats|kafka|redpanda|redis|amqp`), auth (`--auth`, JWT + proto-driven authorization), service catalog (`--catalog`, typed `ctx.call`/`ctx.stream`), opt-in resilience interceptors (`--resilience timeout,retry,...`), and health/reflection toggles. Runtime (`node`/`bun`), package manager (`pnpm`/`npm`/`bun`) and the Node execution model (`raw` `.ts` >= 25.2 vs `tsx` >= 22.13) are all first-class choices.
  - **Deterministic interceptor order.** When several interceptor-adding modules are selected the composition root emits one canonical chain (outermost → innermost): OpenTelemetry → error handler → auth → validation → resilience → custom, with exactly one error handler.
  - **Lifecycle fix baked in.** `buf generate` is chained into the generated `start` / `test` / `typecheck` scripts (not a pnpm `pre*` hook, which silently no-ops), so a fresh clone never fails with an unresolved `#gen/...` import. Standalone pnpm projects also get the `buf` build-approval that pnpm 11 requires.
  - **`connectum generate service <name>`** adds a service to an existing project: a starter proto plus a `defineService` skeleton whose rpc handlers throw `Code.Unimplemented` (a deliberate, documented trade-off — the handler-map key must still exist, so a later proto method addition remains a compile error). `--with-events` also scaffolds an event-handler service and an ack-by-default `EventRoute`. It never edits your `src/server.ts`; it prints the exact registration to add.
  - **Generated tests are runtime-agnostic**: the e2e test uses the public in-process `createLocalClient` from `@connectum/testing` (no socket, identical on Node and Bun); event-enabled projects also get a broker-free `MemoryAdapter` smoke test.
  - A CI scaffold matrix (`cli-scaffold-matrix`) scaffolds each named module combination and runs `buf generate` → typecheck → test, so a broken fragment fails CI.

### Patch Changes

- [#229](https://github.com/Connectum-Framework/connectum/pull/229) [`8ed62cf`](https://github.com/Connectum-Framework/connectum/commit/8ed62cfaaf96cb2f08cadf3db9d0ab9c1b70b236) Thanks [@intech](https://github.com/intech)! - Fetch the `init` base project with `giget` instead of `tiged`.
  
  `tiged` depends on `tar`, and the releases it pins (`^6.1.11`) carry a critical
  decompression denial-of-service advisory and a high-severity arbitrary
  file-overwrite advisory. `tiged@2.12.8` is its latest release, so upgrading does not
  reach a fixed `tar` — the constraint is in `tiged` itself. That matters more here
  than it would elsewhere: a scaffolder exists to download and unpack a remote
  archive, so the extraction path is exactly the exposed one.
  
  `giget` is the maintained degit-style downloader from the same project family as
  `citty`, which this CLI already uses, and it has **no dependencies at all**. The
  change removes the critical and both high advisories from the CLI's production
  dependency closure and drops nine transitive packages.
  
  The fetcher was already injectable behind `CloneFn`, so the change is confined to
  the default implementation. The only externally visible difference is the spec
  format: giget needs its `gh:` provider prefix, so the base is now requested as
  `gh:Connectum-Framework/examples/getting-started#<ref>`. `connectum init` was run
  end to end against the real repository to confirm it.

- [#279](https://github.com/Connectum-Framework/connectum/pull/279) [`7001ec7`](https://github.com/Connectum-Framework/connectum/commit/7001ec724118f6268923d873cd69d6953d44eebd) Thanks [@intech](https://github.com/intech)! - `connectum init --package-manager pnpm --otel` no longer produces a project whose first
  `pnpm install` fails.
  
  pnpm 11 and later exit with `ERR_PNPM_IGNORED_BUILDS` when any dependency has a build
  script that the project neither approves nor denies. The OpenTelemetry module pulls in
  `protobufjs` (through the OTLP gRPC exporters), which declares a `postinstall`, and the
  generated `pnpm-workspace.yaml` did not list it, so the install stopped with exit code 1.
  
  The generated `allowBuilds` map now lists every package with a build script that any
  module combination installs: `@bufbuild/buf` and `esbuild` stay approved (their scripts
  locate or download the platform binary the project needs), and `protobufjs` is denied
  explicitly — its script only prints a version-prefix warning and has no runtime effect.
  Projects already scaffolded can add `protobufjs: false` under `allowBuilds` in their
  `pnpm-workspace.yaml`.

- [#283](https://github.com/Connectum-Framework/connectum/pull/283) [`0cc15bb`](https://github.com/Connectum-Framework/connectum/commit/0cc15bb38fe23d8e9ac1a4b669b97c0b496d5e76) Thanks [@intech](https://github.com/intech)! - Serve gRPC Server Reflection with Connectum's own implementation and drop `@lambdalisue/connectrpc-grpcreflect`.
  
  That package declared `@bufbuild/protobuf` and `@connectrpc/connect` as regular dependencies, so a package manager could install a private protobuf copy for it next to the application's. `@connectum/reflection` and the reflection client behind `connectum proto sync` now use code generated from the upstream `grpc.reflection.v1` / `v1alpha` protos, with no third-party reflection package. The public API is unchanged.
  
  Responses now follow the reflection protocol where the previous implementation did not:
  
  - `grpcurl describe pkg.Service.Method` works: `file_containing_symbol` resolves methods, fields, oneofs, enum values, map entries and extensions, not only types and services.
  - File answers carry the requested file and its transitive imports (well-known types included), without repeating files already sent on the same stream.
  - `all_extension_numbers_of_type` fills `base_type_name` and lists numbers in ascending order; an unknown type is `NOT_FOUND` instead of an empty list.
  - A not-found extension names the type and number instead of `File not found: [object Object]`.
  - A request with no query set gets an `INVALID_ARGUMENT` error response instead of an empty one; the stream stays open.
  - `list_services` lists the mounted services only: not services declared in a file that is merely imported, nor the unmounted services of a file that also declares a mounted one.
  
  `connectum proto sync` and `@connectum/cli/utils/reflection` return the same file order and descriptor-set bytes as before (the service list changes only as described above), and still fall back to v1alpha for servers without v1.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#280](https://github.com/Connectum-Framework/connectum/pull/280) [`249616f`](https://github.com/Connectum-Framework/connectum/commit/249616fb3d5e3d0eae1ec6ee7c4eeb035ddb58a5) Thanks [@intech](https://github.com/intech)! - `connectum init`: projects with Protobuf enums now type-check and run under native type stripping.
  
  A scaffolded project runs `node src/index.ts` with Node's native type stripping and type-checks with `erasableSyntaxOnly`, and both reject a TypeScript `enum`. protoc-gen-es emitted one for every Protobuf enum, so the first enum a user added broke `start` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) and `typecheck` (TS1294).
  
  - The generated `buf.gen.yaml` passes `erasable_syntax=true` to protoc-gen-es (not to the catalog plugin, which rejects unknown options). An enum is generated as an `as const` object plus a type of the same name: `Color.RED` works as before, there is no reverse mapping (`Color[1]`), a single value's type is `typeof Color.RED`, and an open enum's type also admits `UnknownEnum`.
  - The scaffolded `package.json` declares `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` at `^2.16.0` or higher, whatever the fetched base declares, so `connectum init --ref <older base>` also produces a project that can use the erasable output. A base that already declares a higher range keeps it.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

## 1.2.0

## 1.1.0

### Patch Changes

- [#164](https://github.com/Connectum-Framework/connectum/pull/164) [`c7d299e`](https://github.com/Connectum-Framework/connectum/commit/c7d299ea3d229a5c05e5f9ad9e51e75a21818d62) Thanks [@intech](https://github.com/intech)! - Read the CLI version from `package.json` so `connectum --version` always reports the real published release. It previously printed a hand-maintained string (`0.2.0-alpha.2`) that had drifted from the actual package version.

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

## 1.0.0

### Major Changes

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

- [#8](https://github.com/Connectum-Framework/connectum/pull/8) [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e) Thanks [@intech](https://github.com/intech)! - Обновлены production-зависимости:

  **@connectum/otel** (minor):

  - OpenTelemetry SDK обновлён до v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
  - Resource class заменён на resourceFromAttributes()
  - LoggerProvider: processors передаются через constructor
  - MeterProvider: добавлен resource parameter

  **@connectum/core** (minor):

  - Zod обновлён с v3 до v4 (^4.3.6)
  - Изменён тип возврата safeParseEnvConfig (убрана явная аннотация z.SafeParseReturnType)

  **@connectum/cli** (patch):

  - citty обновлён до ^0.2.1
  - Исправлена типизация ProtoSyncOptions.template для exactOptionalPropertyTypes

  Также обновлены:

  - @biomejs/biome: ^1.9.4 → ^2.3.15 (конфиг автомигрирован)

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

## 1.0.0-rc.11

## 1.0.0-rc.10

## 1.0.0-rc.9

## 1.0.0-rc.8

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

## 1.0.0-rc.7

## 1.0.0-rc.6

## 1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

## 1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- [#8](https://github.com/Connectum-Framework/connectum/pull/8) [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e) Thanks [@intech](https://github.com/intech)! - Updated production dependencies:

  **@connectum/otel** (minor):

  - OpenTelemetry SDK updated to v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
  - Resource class replaced with resourceFromAttributes()
  - LoggerProvider: processors are now passed via the constructor
  - MeterProvider: added resource parameter

  **@connectum/core** (minor):

  - Zod updated from v3 to v4 (^4.3.6)
  - Changed safeParseEnvConfig return type (removed explicit z.SafeParseReturnType annotation)

  **@connectum/cli** (patch):

  - citty updated to ^0.2.1
  - Fixed ProtoSyncOptions.template typing for exactOptionalPropertyTypes

  Also updated:

  - @biomejs/biome: ^1.9.4 → ^2.3.15 (config auto-migrated)

## 1.0.0-beta.2

## 0.2.0-beta.1

### Patch Changes

- chore: clean up package dependencies
- chore: update dependencies

## 0.2.0-alpha.2

Initial alpha release.

# Release publish-boundary gate

Validates the framework **as a third-party consumer experiences it**, against the
**packed** artifacts — not against `src/` or in-workspace `dist/`. This catches
publish-boundary defects that the framework build, `tsc`, and the (type-stripped)
examples cannot see: broken `exports` maps, `.d.ts` ↔ `.js` drift (build-drop),
unimportable subpaths, and catalog-codegen breakage.

## What it does

`run.mjs` builds a throwaway consumer from [`fixture/`](./fixture), installs every
published `@connectum/*` package from the chosen source, generates the service
catalog, then runs the publish-boundary checks, compiled cancellation checks,
the behavioral smoke and a single-copy check:

1. **export-map** ([`checks/oracle.mjs`](./fixture/checks/oracle.mjs)) — every `exports` subpath resolves to a real file on disk.
2. **`.d.ts` graph** ([`checks/oracle.mjs`](./fixture/checks/oracle.mjs)) —
   namespace-imports every subpath and type-checks the full declaration graph
   with `skipLibCheck: false` under a realistic consumer tsconfig (DOM/fetch lib
   via `target esnext`, so `@connectrpc`-inherited globals like `HeadersInit`
   resolve). Enumerates each subpath's value/type exports into `gen-cov/report.json`.
3. **value-export completeness** ([`checks/completeness.mjs`](./fixture/checks/completeness.mjs)) —
   `.d.ts` value exports must be present in the runtime `Object.keys` (build-drop),
   and no runtime value may be declared type-only (the inverse).
4. **runtime importability** ([`checks/runtime-import.mjs`](./fixture/checks/runtime-import.mjs)) —
   every subpath `import()`s under Node ESM. Type-only subpaths (0 declared value
   exports) are expected to be empty; executable / buf-plugin entries are skipped
   with a documented reason ([`checks/allowlist.mjs`](./fixture/checks/allowlist.mjs)).
5. **one module instance per package** ([`checks/module-identity.mjs`](./fixture/checks/module-identity.mjs)) —
   a name exported by two or more subpaths of one package must be the same runtime
   value (`===`) from each. A multi-entry build without `splitting` copies shared
   modules into every subpath, so singletons (the OpenTelemetry provider), classes
   and module state would exist once per subpath.
6. **exported error class names** ([`checks/class-names.mjs`](./fixture/checks/class-names.mjs)) —
   every error class a package exports keeps its public name in the packed build:
   `Class.name` equals the name it is exported under, and an instance reports the same
   `constructor.name`, with neither `stack` nor `util.inspect` output starting with an
   underscore-prefixed name (the inner name a bundler gives a class that refers to itself).
7. **node: builtin prefixes** ([`checks/builtins.mjs`](./fixture/checks/builtins.mjs)) —
   no prefix-only builtin (`node:test`/`sqlite`/`sea`) ships with its `node:` prefix stripped.
7a. **manifest metadata** ([`checks/manifest-metadata.mjs`](./fixture/checks/manifest-metadata.mjs)) —
   every installed `@connectum/*` manifest carries `homepage` (its page on the documentation
   site), `bugs.url` (the repository issue tracker) and `repository` (type `git`, one shared
   `git+https` URL, `directory` of the package), so the npm package page and
   `npm docs` / `npm bugs` / `npm repo` work for every package.
8. **consumer usage type-check** ([`checks/usage-typecheck.mjs`](./fixture/checks/usage-typecheck.mjs)) —
   a cast-free fixture ([`src/usage.ts`](./fixture/src/usage.ts)) compiles documented
   signatures against the packed `.d.ts`, catching signature regressions.
9. **packed resilience cancellation** ([`checks/resilience-cancellation.mjs`](./fixture/checks/resilience-cancellation.mjs)) — verifies own deadline propagation,
   structured caller errors, interruptible retry backoff, waiting for active work
   and independent mock request signals through installed main/subpath exports.
10. **generated EventBus type-check** ([`checks/generated-eventbus.mjs`](./fixture/checks/generated-eventbus.mjs)) —
   runs the packed CLI (`connectum init --events <adapter>`) for the NATS, Kafka, Redis and AMQP
   adapter packages, generates the protos with the consumer's `buf`, and `tsc --noEmit`s each
   generated project against the packed packages. This is the only check that compiles the
   generated `<name>EventBus.ts` and event-handler service; it needs network access, because the
   CLI downloads its base project from a pinned `examples` tag.
11. **behavioral smoke** ([`fixture/src/smoke.ts`](./fixture/src/smoke.ts)) — calls
   public functions not covered by the example e2e (catalog key-validation,
   resolvers, `defaultFailurePredicate` classification, opt-in interceptors, otel
   getters, auth helpers, healthcheck, events helpers, testing mocks, real `ctx.call`).
12. **single copy of protobuf / Connect** (`scripts/lib/runtime-participants.mjs`) — the
   fixture pins `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node`
   inside the framework's peer ranges, and the consumer has no workspace override, so
   every runtime participant must resolve one copy of each. In `pack` mode each installed
   `@connectum/*` manifest must also equal the one in its tarball, so an override that
   silently fell back to the registry fails.

The out-of-range side of the dependency contract (npm refuses, pnpm and Bun warn) needs
npm and Bun, so it is checked by `pnpm dependency-contract:check`
([`scripts/dependency-contract/check.mjs`](../dependency-contract/check.mjs)), not here.

The gate exits non-zero if any check fails.

## Running

```bash
# Local: build + pnpm-pack the workspace, then validate the tarballs
pnpm release:gate

# Pre-release: validate a pkg-pr-new snapshot (pinned to a commit SHA)
pnpm release:gate:preview --ref <commit-sha>
```

In CI the gate runs automatically on every PR to `main` (in `snapshot.yml`,
after the pkg-pr-new snapshot publishes) against that PR's pre-release build.

## Scope

Verifies the publish boundary and pure/in-process behavior directly. The smoke
also opens real HTTP/2 and HTTP/1.1 connections to check idle-session drain and
force-close shutdown behavior on the consumer runtime floor. Streaming/bidi
RPC paths, broker-backed adapters, and the auth interceptors require their
dedicated integration or example suites; this gate does not cover those paths.

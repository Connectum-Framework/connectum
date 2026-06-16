# Release publish-boundary gate

Validates the framework **as a third-party consumer experiences it**, against the
**packed** artifacts — not against `src/` or in-workspace `dist/`. This catches
publish-boundary defects that the framework build, `tsc`, and the (type-stripped)
examples cannot see: broken `exports` maps, `.d.ts` ↔ `.js` drift (build-drop),
unimportable subpaths, and catalog-codegen breakage.

## What it does

`run.mjs` builds a throwaway consumer from [`fixture/`](./fixture), installs every
published `@connectum/*` package from the chosen source, generates the service
catalog, then runs six publish-boundary checks plus the behavioral smoke:

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
5. **node: builtin prefixes** ([`checks/builtins.mjs`](./fixture/checks/builtins.mjs)) —
   no prefix-only builtin (`node:test`/`sqlite`/`sea`) ships with its `node:` prefix stripped.
6. **consumer usage type-check** ([`checks/usage-typecheck.mjs`](./fixture/checks/usage-typecheck.mjs)) —
   a cast-free fixture ([`src/usage.ts`](./fixture/src/usage.ts)) compiles documented
   signatures against the packed `.d.ts`, catching signature regressions.
7. **behavioral smoke** ([`fixture/src/smoke.ts`](./fixture/src/smoke.ts)) — calls
   public functions not covered by the example e2e (catalog key-validation,
   resolvers, `defaultFailurePredicate` classification, opt-in interceptors, otel
   getters, auth helpers, healthcheck, events helpers, testing mocks, real `ctx.call`).

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

Verifies the publish boundary and pure/in-process behavior directly. RPC-path
runtime (streaming/bidi), broker-backed adapters, and the auth interceptors are
covered by the example e2e, not by this gate.

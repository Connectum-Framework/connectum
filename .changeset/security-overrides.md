---
---

Resolve critical and high security vulnerabilities (CVE-2026-27699, CVE-2026-27606, CVE-2026-26996, CVE-2026-27903) via pnpm overrides for basic-ftp, rollup, and minimatch.

Additional Dependabot alert resolutions via pnpm overrides:

- `protobufjs` floor raised `<7.5.5 → 7.5.8` (transitive via `@grpc/grpc-js → @grpc/proto-loader`).
- `@grpc/grpc-js` floor `<1.14.4 → 1.14.4` (transitive via the OpenTelemetry OTLP/gRPC exporters).
- `fast-uri` floor `<3.1.2 → 3.1.2` (dev-only, via `ajv → @commitlint`).
- `qs` floor `<6.15.2 → 6.15.2` (dev-only, via `@exodus/test`).

The duplicate `protobufjs@8.x` copy (via `@opentelemetry/otlp-transformer`) is
resolved separately by upgrading OpenTelemetry to `0.219.0` (its transformer no
longer depends on `protobufjs`), not by an override. The `esbuild` advisory is
deferred: `esbuild@0.28.x` is incompatible with the current `tsup` (`esbuild
^0.25`), and esbuild is a build-time tool that does not ship in the compiled
`dist`.

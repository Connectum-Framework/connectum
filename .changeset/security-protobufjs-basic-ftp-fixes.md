---
"@connectum/otel": patch
---

security(deps): force patched versions of protobufjs and basic-ftp via pnpm overrides

Resolves Dependabot alerts on main branch:

- **GHSA-xq3m-2v4x-88gg** (Critical) — Arbitrary code execution in protobufjs < 7.5.5
  (transitive via `@grpc/proto-loader` under OTel gRPC exporters).
- **GHSA-xq3m-2v4x-88gg** (Critical) — Arbitrary code execution in protobufjs 8.0.0
  (transitive via `@opentelemetry/otlp-transformer`).
- **GHSA-chqc-8p9q-pq6q** (High) — basic-ftp 5.2.0 FTP Command Injection via CRLF
  (dev-only transitive via `@exodus/test` → puppeteer-core).
- **GHSA-6v7q-wjvx-w8wg** (High) — basic-ftp ≤ 5.2.1 incomplete CRLF protection
  (dev-only transitive via `@exodus/test` → puppeteer-core).

No runtime API changes. Only `pnpm.overrides` in the monorepo root were adjusted
to force patched transitive versions: `protobufjs@<7.5.5 → 7.5.5`,
`protobufjs@>=8.0.0 <8.0.1 → 8.0.1`, `basic-ftp@<5.2.2 → 5.2.2`.

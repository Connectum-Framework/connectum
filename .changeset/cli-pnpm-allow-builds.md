---
"@connectum/cli": patch
---

`connectum init --package-manager pnpm --otel` no longer produces a project whose first
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

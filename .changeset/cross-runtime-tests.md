---
"@connectum/core": patch
---

Add cross-runtime test scripts (`test:bun`, `test:esbuild`) to all packages via `@exodus/test`. Packages with known incompatibilities (interceptors/bun, otel/bun, cli/bun) gracefully skip. Root `test:cross-runtime` runs all runtimes via turbo.

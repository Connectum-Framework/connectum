# @connectum/protoc-gen-catalog

## 1.0.0

### Minor Changes

- [#152](https://github.com/Connectum-Framework/connectum/pull/152) [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837) Thanks [@intech](https://github.com/intech)! - feat(protoc-gen-catalog): new Buf/protoc plugin that generates the service catalog

  New package `@connectum/protoc-gen-catalog` — the `protoc-gen-connectum-catalog`
  plugin emits one `catalog.gen.ts` per buf module containing a runtime
  `serviceCatalog` object and the `@connectum/core` `ConnectumCallMap` /
  `ConnectumStreamMap` augmentation that types `ctx.call` / `ctx.stream`.

  Built on `@bufbuild/protoplugin`. Generated files carry the mandatory
  `import type {} from "@connectum/core";` (so the augmentation merges across
  packages), use the configured `import_extension` (`.js` recommended), classify
  methods via `DescMethod.methodKind` (kebab stream kinds), and include only
  files-to-generate. Requires `strategy: all` in `buf.gen.yaml`. `output_file`
  option supported (absolute / `..`-traversal paths rejected); empty input emits a
  valid empty catalog.

### Patch Changes

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

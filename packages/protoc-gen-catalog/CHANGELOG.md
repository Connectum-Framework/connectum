# @connectum/protoc-gen-catalog

## 1.3.0

### Patch Changes

- [#243](https://github.com/Connectum-Framework/connectum/pull/243) [`10a3e58`](https://github.com/Connectum-Framework/connectum/commit/10a3e584a1f8c6c80d96c533d88dc02300805289) Thanks [@intech](https://github.com/intech)! - Update protobuf-es to 2.13.0 and clear the remaining dependency advisories.

  `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` move to
  2.13.0, and `@bufbuild/buf` to 1.72.0. The single-instance pin moves with them:
  `@bufbuild/protoplugin` was still on 2.12.1 and pinned a second copy of
  `@bufbuild/protobuf`, which is exactly the split the pin exists to prevent -- two
  instances break `@connectrpc/connect`'s protobuf peer and the reflection DTS build.
  The workspace now resolves a single 2.13.0.

  connect-es is unchanged: `@connectrpc/connect` and `@connectrpc/connect-node` 2.1.2
  are already the latest published releases.

  Several `overrides` were pinned to the version that closed an _earlier_ advisory
  and had since been superseded: `brace-expansion` 5.0.5 -> 5.0.9, `js-yaml` 4.2.0 ->
  4.3.0 (plus a new pin for the 3.x line `@changesets/cli` pulls), `fast-uri` 3.1.2 ->
  3.1.5, `basic-ftp` 5.2.2 -> 5.3.1, `protobufjs` 7.6.3 -> 7.6.5, and new pins for
  `ip-address`, `linkify-it`, `undici` and `ws`. Every target is published and stays
  inside the major already installed.

  `pnpm audit` now reports no vulnerabilities at any severity, dev included; it
  previously reported 1 critical, 21 high and 14 moderate.

## 1.2.0

## 1.1.0

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

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

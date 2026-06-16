---
"@connectum/protoc-gen-catalog": minor
---

feat(protoc-gen-catalog): new Buf/protoc plugin that generates the service catalog

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

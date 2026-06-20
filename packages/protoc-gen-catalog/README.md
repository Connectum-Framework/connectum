# @connectum/protoc-gen-catalog

A Buf/protoc plugin that generates a **Connectum service catalog** from your
proto files. The generated `catalog.gen.ts` is what makes `ctx.call` and
`ctx.stream` (from `@connectum/core`) fully typed.

## Installation

```bash
pnpm add -D @connectum/protoc-gen-catalog
```

The package installs the `protoc-gen-connectum-catalog` binary, which Buf/protoc
invoke as a `local` plugin (see Usage below).

## What it generates

One `catalog.gen.ts` per buf module, containing:

- a runtime `serviceCatalog` object keyed by proto `typeName` (pass it to
  `createServer({ catalog: serviceCatalog })`);
- module augmentation of `@connectum/core`'s `ConnectumCallMap` (unary methods)
  and `ConnectumStreamMap` (streaming methods), typing every `ctx.call` /
  `ctx.stream` key.

```ts
// catalog.gen.ts (generated — DO NOT EDIT)
import type {} from "@connectum/core";
import { GreeterService } from "./greeter_pb.js";
import type { SayHelloRequest, SayHelloResponse } from "./greeter_pb.js";

export const serviceCatalog = {
    "greeter.v1.GreeterService": GreeterService,
} as const;

declare module "@connectum/core" {
    interface ConnectumCallMap {
        "greeter.v1.GreeterService/SayHello": { request: SayHelloRequest; response: SayHelloResponse };
    }
    interface ConnectumStreamMap {}
}
```

## Quick Start (`buf.gen.yaml`)

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: gen
    opt: [target=ts, import_extension=.js]
  - local: protoc-gen-connectum-catalog
    strategy: all
    out: gen
    opt: [target=ts, import_extension=.js]
```

`strategy: all` is **required**. The catalog aggregates every service into a
single `catalog.gen.ts`, so buf must invoke the plugin once over all files. With
the default `directory` strategy, buf runs the plugin once per proto directory
and emits a duplicate `catalog.gen.ts` — keeping only one directory's services.

The catalog plugin emits **TypeScript only** (the `declare module` augmentation
is types-only). Generate it alongside `protoc-gen-es`, with the **same
`import_extension`** so the catalog's imports match the protobuf-es output.

- `import_extension=.js` — recommended (pre-compiled distribution: tsup → `.js`
  + `.d.ts`).
- `import_extension=.ts` — raw-source distribution (Bun / Node 22+ strip-types /
  Node 25.2+). Use only if you ship `.ts` and your `tsconfig` allows it.

## API Reference

The plugin parameter string accepts the following option (passed via `opt:` in
`buf.gen.yaml`):

| Option | Default | Description |
|--------|---------|-------------|
| `output_file` | `catalog.gen.ts` | Output file name, relative to the output root. Absolute paths (POSIX and Windows) and `..` traversal are rejected. |

## Important

- The generated file **must** be loaded by your contracts package — re-export
  it from `index.ts` or add a top-level `import "./catalog.gen.ts";`. Without
  it, consumers silently see missing `ConnectumCallMap` keys.
- The mandatory `import type {} from "@connectum/core";` line is required for the
  augmentation to merge in cross-package builds (avoids `TS2664`). Do not remove it.
- The plugin generates services from **files-to-generate** only, not from the
  transitive proto import graph.

## Dependencies

- `@bufbuild/protobuf` — proto descriptors (`DescService`).
- `@bufbuild/protoplugin` — plugin framework (`createEcmaScriptPlugin`, `runNodeJs`).

## Requirements

- Node.js >=22.13.0

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

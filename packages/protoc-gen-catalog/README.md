# @connectum/protoc-gen-catalog

This README documents `@connectum/protoc-gen-catalog` 1.3 and later.

A Buf/protoc plugin that generates a **Connectum service catalog** from your
proto files. The generated `catalog.gen.ts` is what makes `ctx.call` and
`ctx.stream` (from `@connectum/core`) fully typed.

## Installation

```bash
pnpm add @connectum/core
pnpm add -D @connectum/protoc-gen-catalog @bufbuild/buf @bufbuild/protoc-gen-es
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
import { GreeterService } from "./greeter/v1/greeter_pb.js";
import type { SayHelloRequest, SayHelloResponse } from "./greeter/v1/greeter_pb.js";

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

This generated output assumes `buf.yaml` uses `proto` as a module path and
`proto/greeter/v1/greeter.proto` contains:

```yaml
version: v2
modules:
  - path: proto
```

```proto
syntax = "proto3";
package greeter.v1;

message SayHelloRequest { string name = 1; }
message SayHelloResponse { string message = 1; }

service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse);
}
```

With the Buf config below, `buf generate` writes the protobuf module to
`gen/greeter/v1/greeter_pb.ts` and the catalog to `gen/catalog.gen.ts`. The
catalog imports the generated service from `./greeter/v1/greeter_pb.js`.

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
single `catalog.gen.ts`, so buf must invoke the plugin once over all files.
Separate directory invocations cannot produce one aggregate catalog: each
invocation emits the same output filename for its own files-to-generate.

The catalog plugin emits **TypeScript only** (the `declare module` augmentation
is types-only). Generate it alongside `protoc-gen-es`, with the **same
`import_extension`** so the catalog's imports match the protobuf-es output.

- `import_extension=.js` — recommended (pre-compiled distribution: tsup → `.js`
  + `.d.ts`).
- `import_extension=.ts` — source execution on the documented Node.js/Bun path.
  Use only if you ship `.ts` and your `tsconfig` allows it; see
  [runtime compatibility](https://connectum.dev/en/guide/runtime-compatibility).

## API Reference

In addition to standard `@bufbuild/protoplugin` options such as `target` and
`import_extension`, the plugin accepts this custom option (passed via `opt:` in
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

Unlike the Connectum runtime packages, this plugin keeps `@bufbuild/protobuf` as a
regular dependency, not a peer. It is an executable that runs at code-generation time,
and `@bufbuild/protoplugin` pins `@bufbuild/protobuf` to one exact version, so its copy
cannot be promised to be the one your application uses. It is therefore outside the
single-copy guarantee of the runtime packages — including the `@bufbuild/protoplugin`
`Plugin` value the package entry exports, whose types come from the plugin's own copy.

## Requirements

- Node.js >=22.13.0

## Learn and reference

- [Package overview](https://connectum.dev/en/packages/protoc-gen-catalog)
- [Service catalog guide](https://connectum.dev/en/guide/service-communication/service-catalog)
- [API reference](https://connectum.dev/en/api/@connectum/protoc-gen-catalog/)

## License

Apache-2.0

---

**Part of [Connectum](../../README.md).**

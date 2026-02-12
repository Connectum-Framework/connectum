# @connectum/cli

CLI tools for the Connectum gRPC/ConnectRPC framework.

## Installation

```bash
pnpm add @connectum/cli
```

Requires Node.js >= 25.2.0 (native TypeScript support).

## Commands

### `connectum proto sync`

Sync proto types from a running Connectum server via gRPC Server Reflection.

**Pipeline:**
1. Connect to server via `ServerReflectionClient` (HTTP/2, gRPC protocol)
2. Discover services and download `FileDescriptorProto` descriptors
3. Serialize as `FileDescriptorSet` binary (`.binpb`)
4. Run `buf generate` with `.binpb` input to produce TypeScript stubs

**Usage:**

```bash
# Full sync: generate TypeScript types from a running server
connectum proto sync --from localhost:5000 --out ./gen

# With custom buf.gen.yaml template
connectum proto sync --from localhost:5000 --out ./gen --template ./buf.gen.yaml

# Dry-run: list services and files without generating code
connectum proto sync --from localhost:5000 --out ./gen --dry-run
```

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--from` | string | Yes | Server address (e.g., `localhost:5000` or `http://localhost:5000`) |
| `--out` | string | Yes | Output directory for generated types |
| `--template` | string | No | Path to custom `buf.gen.yaml` template |
| `--dry-run` | boolean | No | Show services and files without generating code |

**Dry-run output example:**

```
Connected to http://localhost:5000
Services:
  - grpc.health.v1.Health
  - mypackage.v1.MyService
Files:
  - grpc/health/v1/health.proto
  - mypackage/v1/myservice.proto
Would generate to: ./gen
```

## Prerequisites

- **Running server** with `reflection: true` enabled
- **buf CLI** installed (`@bufbuild/buf` or system-wide)
- **buf.gen.yaml** in the current directory (or provided via `--template`)

## Programmatic API

The CLI also exports functions for programmatic use:

```typescript
import { fetchReflectionData, fetchFileDescriptorSetBinary } from "@connectum/cli/utils/reflection";
import { executeProtoSync } from "@connectum/cli/commands/proto-sync";

// Fetch service and file information
const result = await fetchReflectionData("http://localhost:5000");
console.log(result.services);  // ["grpc.health.v1.Health", ...]
console.log(result.fileNames); // ["grpc/health/v1/health.proto", ...]

// Fetch binary FileDescriptorSet for custom processing
const binpb = await fetchFileDescriptorSetBinary("http://localhost:5000");

// Execute full proto sync pipeline
await executeProtoSync({
  from: "localhost:5000",
  out: "./gen",
  dryRun: false,
});
```

## Architecture

```
@connectum/cli (Layer 3)
  depends on:
    @lambdalisue/connectrpc-grpcreflect  -- reflection client
    @bufbuild/protobuf                    -- protobuf serialization
    @connectrpc/connect-node              -- gRPC transport (HTTP/2)
    @bufbuild/buf                         -- code generation
    citty                                 -- CLI framework
```

## Related

- [ADR-020: Reflection-based Proto Synchronization](../../docs/contributing/adr/020-reflection-proto-sync.md)
- [@lambdalisue/connectrpc-grpcreflect](https://www.npmjs.com/package/@lambdalisue/connectrpc-grpcreflect)
- [Buf Inputs Reference](https://buf.build/docs/reference/inputs/)

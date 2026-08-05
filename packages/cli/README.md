# @connectum/cli

CLI tools for the Connectum gRPC/ConnectRPC framework.

**Command-line tooling for Connectum services — scaffold a new project, add services, and synchronize proto types from a running server.**

## Features

- `connectum init` — scaffold a production-ready project (interactive wizard or flags), composing optional modules: OpenTelemetry, EventBus (NATS / Kafka / Redpanda / Redis / AMQP), auth (JWT + proto authorization), service catalog, resilience interceptors
- `connectum generate service` — add a service (rpc and/or event handlers) to an existing project
- `connectum proto sync` — generate TypeScript proto stubs from a live server via gRPC Server Reflection
- Dry-run mode to inspect discovered services and files without generating code
- Programmatic API (`fetchReflectionData`, `fetchFileDescriptorSetBinary`, `executeProtoSync`) for custom tooling

## Installation

```bash
pnpm add @connectum/cli
```

The CLI itself requires Node.js >= 22.13.0. The project it scaffolds targets whichever
runtime you choose: the default `--node-exec raw` runs `.ts` natively and therefore needs
Node.js >= 25.2.0, while `--node-exec tsx` lowers the generated project's floor to 22.13.0.

## Quick Start

```bash
# Scaffold a new project (interactive)
npx @connectum/cli init

# ...or non-interactively, with modules
npx @connectum/cli init payments --package-manager pnpm --otel --events nats --auth --yes

# Add a service to an existing project (run inside the project)
cd payments
connectum generate service billing --with-events

# Generate TypeScript types from a running server with reflection enabled
connectum proto sync --from localhost:5000 --out ./gen
```

## Commands

### `connectum init`

Scaffold a new standalone Connectum project. The base is fetched from the dogfooded
`getting-started` example (so the starter layout stays in sync with a tested example)
and the selected modules are composed on top. Requires network access on first run.

`buf generate` is chained into the generated `start` / `test` / `typecheck` scripts, so
the code under `gen/` is always current — no "cannot find module `#gen/...`" wall.

**Usage:**

```bash
connectum init [name] [options]
```

| Flag | Values | Description |
|------|--------|-------------|
| `--runtime` | `node` (default), `bun` | Target runtime |
| `--package-manager` | `pnpm` (default), `npm`, `bun` | Package manager |
| `--node-exec` | `raw` (default), `tsx` | `raw` runs `.ts` directly (Node >= 25.2); `tsx` runs on Node >= 22.13 |
| `--otel` | — | OpenTelemetry interceptor + provider lifecycle |
| `--events` | `nats`, `kafka`, `redpanda`, `redis`, `amqp` | EventBus with the chosen adapter |
| `--auth` | — | JWT authentication + proto-driven authorization |
| `--catalog` | — | Service catalog (typed `ctx.call` / `ctx.stream`) |
| `--resilience` | `timeout,bulkhead,circuitBreaker,retry,fallback` | Opt-in resilience interceptors |
| `--healthcheck` / `--no-healthcheck` | — | gRPC health protocol (default on) |
| `--reflection` / `--no-reflection` | — | gRPC server reflection (default on) |
| `--sample` / `--no-sample` | — | Runnable sample Greeter service (default on) |
| `--yes`, `-y` | — | Non-interactive (flags + defaults) |
| `--force` | — | Overwrite existing files |
| `--ref` | git ref | Base example ref to fetch (advanced; defaults to a pinned tag) |

When several interceptor-adding modules are selected, the composition root emits one
consistent order (outermost → innermost): **OpenTelemetry → error handler → auth →
validation → resilience → custom**.

### `connectum generate service`

Add a service to an existing project.

```bash
connectum generate service <name> [--with-events] [--force]
```

Scaffolds `proto/<name>/v1/<name>.proto` and `src/services/<name>Service.ts` (a
`defineService` skeleton whose rpc handlers throw `Code.Unimplemented`; with
`--with-events`, also an `EventRoute` with an ack-by-default handler). It never edits
your `src/server.ts` — it prints the exact registration line to add.

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
Connecting to http://localhost:5000...
Connected to http://localhost:5000
Services:
  - grpc.health.v1.Health
  - mypackage.v1.MyService
Files:
  - grpc/health/v1/health.proto
  - mypackage/v1/myservice.proto
Would generate to: ./gen
```

## Requirements

- **Node.js** >= 22.13.0
- **Running server** with `reflection: true` enabled
- **buf CLI** installed (`@bufbuild/buf` or system-wide)
- **buf.gen.yaml** in the current directory (or provided via `--template`)

## API Reference

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
@connectum/cli (Layer 2)
  depends on:
    @lambdalisue/connectrpc-grpcreflect  -- reflection client
    @bufbuild/protobuf                    -- protobuf serialization
    @connectrpc/connect                   -- ConnectRPC core types
    @connectrpc/connect-node              -- gRPC transport (HTTP/2)
    @bufbuild/buf                         -- code generation
    citty                                 -- CLI framework
```

## Related

- [ADR-020: Reflection-based Proto Synchronization](https://connectum.dev/en/contributing/adr/020-reflection-proto-sync)
- [@lambdalisue/connectrpc-grpcreflect](https://www.npmjs.com/package/@lambdalisue/connectrpc-grpcreflect)
- [Buf Inputs Reference](https://buf.build/docs/reference/inputs/)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** — Universal framework for production-ready gRPC/ConnectRPC microservices

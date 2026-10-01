# @connectum/reflection

gRPC Server Reflection protocol for Connectum.

**@connectum/reflection** implements the [gRPC Server Reflection Protocol](https://github.com/grpc/grpc/blob/master/doc/server-reflection.md) (v1 + v1alpha) as a Connectum protocol plugin. Allows clients like `grpcurl`, Postman, and `buf curl` to discover services, methods, and message types at runtime without requiring proto files.

## Features

- **gRPC Server Reflection v1 + v1alpha**: Native implementation of every request kind, including transitive import closure and symbol lookup down to methods, fields and enum values
- **Zero Configuration**: No arguments required, works out of the box
- **Automatic Descriptor Collection**: Recursively collects all proto file descriptors with transitive dependencies
- **Client Compatibility**: Works with grpcurl, Postman, buf curl, and any gRPC reflection-aware client

## Installation

```bash
pnpm add @connectum/reflection
```

**Peer dependency:**

```bash
pnpm add @connectum/core
```

## Quick Start

```typescript
import { createServer } from '@connectum/core';
import { Reflection } from '@connectum/reflection';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Reflection()],
});

await server.start();

// Clients can now discover services via gRPC Server Reflection
```

## API Reference

### Reflection()

Factory function that creates a `ProtocolRegistration` for the gRPC Server Reflection protocol.

```typescript
import { Reflection } from '@connectum/reflection';

function Reflection(): ProtocolRegistration;
```

The function takes no arguments. It automatically collects the registered service file descriptors from the `ProtocolContext` — every application service plus the services of protocols listed before it — and indexes them for the reflection service.

Pass the result to `createServer({ protocols: [...] })`.

### collectFileProtos(files)

Utility function that recursively collects `FileDescriptorProto` objects from `DescFile` entries, including transitive dependencies. Deduplicates by file name using depth-first traversal.

```typescript
import { collectFileProtos } from '@connectum/reflection';
import type { DescFile } from '@bufbuild/protobuf';

function collectFileProtos(files: ReadonlyArray<DescFile>): DescFile['proto'][];
```

This is primarily used internally by `Reflection()` but is exported for advanced use cases where you need direct access to file descriptors.

## How It Works

Once per server, in `setup`, the `Reflection` protocol:

1. Receives the registered service file descriptors via `ProtocolContext.registry`
2. Recursively collects all proto file descriptors and their dependencies using `collectFileProtos()`
3. Indexes them by file name, by fully-qualified symbol and by extension

Then, for every router the server builds (the HTTP adapter and each in-process transport), `register` mounts `grpc.reflection.v1.ServerReflection` and `grpc.reflection.v1alpha.ServerReflection` on that same index. HTTP and in-process clients therefore see the same answers.

### Protocol behavior

| Request | Answer |
|---------|--------|
| `list_services` | Services mounted before `Reflection()`: every application service and the protocols listed earlier in `protocols`. The reflection service does not list itself; services declared only in imported files are not listed. |
| `file_by_filename`, `file_containing_symbol`, `file_containing_extension` | The requested file first, then each of its transitive imports (well-known types included) not yet sent on the same stream. |
| `file_containing_symbol` | Resolves services, methods (`pkg.Service.Method`), messages, fields, oneofs, enums, enum values (named in their enum's parent scope) and extensions. |
| `all_extension_numbers_of_type` | `base_type_name` set to the requested type, numbers in ascending order. |
| Unknown file, symbol, extension or type | `error_response` with `NOT_FOUND` (5), naming what was not found. |
| Request with no query set | `error_response` with `INVALID_ARGUMENT` (3). |

Errors are answered per request: the stream stays open for the next request. Every response echoes `valid_host` and `original_request`.

The reflection protos (`proto/grpc/reflection/`) are vendored verbatim from [grpc/grpc-proto](https://github.com/grpc/grpc-proto/tree/master/grpc/reflection).

## Usage with grpcurl

`grpcurl` is the most common client for gRPC Server Reflection:

```bash
# List all services
grpcurl -plaintext localhost:5000 list

# Describe a service
grpcurl -plaintext localhost:5000 describe my.service.v1.MyService

# Describe a method
grpcurl -plaintext localhost:5000 describe my.service.v1.MyService.GetUser

# Call a method (reflection provides the schema)
grpcurl -plaintext -d '{"id": "123"}' \
  localhost:5000 my.service.v1.MyService/GetUser
```

## Usage with buf curl

```bash
# List services
buf curl --protocol grpc --http2-prior-knowledge http://localhost:5000 --list-methods

# Call a method
buf curl --protocol grpc --http2-prior-knowledge \
  -d '{"id": "123"}' \
  http://localhost:5000/my.service.v1.MyService/GetUser
```

## Combined with Healthcheck

Reflection and Healthcheck are typically used together:

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { Reflection } from '@connectum/reflection';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [
    Healthcheck({ httpEnabled: true }),
    Reflection(),
  ],
  shutdown: { autoShutdown: true },
});

server.on('ready', () => {
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();
```

## Exports Summary

| Export | Description |
|--------|-------------|
| `Reflection` | Protocol registration factory |
| `collectFileProtos` | Utility to collect file descriptors with dependencies |

## Dependencies

### Peer Dependencies

- `@connectum/core` -- Server factory and ProtocolRegistration types

### Dependencies

- `@bufbuild/protobuf` -- Protocol Buffers runtime
- `@connectrpc/connect` -- ConnectRPC core

## Requirements

- **Node.js**: >=22.13.0
- **pnpm**: >=11.0.0

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** — Universal framework for production-ready gRPC/ConnectRPC microservices

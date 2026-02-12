# Connectum

<p align="center">
  <img src="https://raw.githubusercontent.com/Connectum-Framework/docs/main/assets/splash.png" alt="Connectum Framework" />
</p>

> Universal framework for building production-ready gRPC/ConnectRPC microservices on Node.js 25+

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D25.2.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Native-blue)](https://nodejs.org/api/typescript.html)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Alpha Release](https://img.shields.io/badge/release-v0.2.0--alpha.1-orange)](https://github.com/Connectum-Framework/connectum/releases/tag/v0.2.0-alpha.2)

## Features

- **Native TypeScript** - stable type stripping in Node.js 25.2.0+ with no build step
- **Zero Configuration** - works out of the box with sensible defaults
- **Production Ready** - built-in observability, health checks, graceful shutdown
- **Type Safe** - full type coverage without `any`
- **Modular** - pick only the components you need
- **Extensible** - flexible interceptor system
- **Explicit Lifecycle** - full control over the server lifecycle

## Quick Start

### Requirements

- **Node.js**: >=25.2.0 (for stable type stripping)
- **pnpm**: >=10

### Installation

```bash
pnpm add @connectum/core
```

### Minimal Example

```typescript
// src/index.ts
import { createServer } from '@connectum/core';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
});

await server.start();
```

### Production Example

```typescript
import { createServer, ServingStatus } from '@connectum/core';
import { createTracingInterceptor, createLoggerInterceptor } from '@connectum/interceptors';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  interceptors: [
    createTracingInterceptor(),
    createLoggerInterceptor(),
  ],
  health: {
    enabled: true,
    httpEnabled: true,  // HTTP /healthz endpoint
  },
  shutdown: {
    autoShutdown: true,  // Graceful shutdown on SIGTERM/SIGINT
    timeout: 30000,
  },
});

// Lifecycle hooks
server.on('ready', () => {
  console.log(`Server ready on port ${server.address?.port}`);
  server.health.update(ServingStatus.SERVING);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

server.on('stop', () => {
  console.log('Server stopped');
});

// Start the server
await server.start();
```

### Running

```bash
# Native TypeScript execution (no build step!)
node src/index.ts

# Development with watch mode
node --watch src/index.ts
```

## Packages

Connectum is organized into 4 modular packages:

| Package | Description | Layer |
|---------|-------------|-------|
| [`@connectum/otel`](packages/otel) | OpenTelemetry instrumentation | 0 |
| [`@connectum/interceptors`](packages/interceptors) | ConnectRPC interceptors | 1 |
| [`@connectum/core`](packages/core) | Main server factory + protocols | 2 |
| [`@connectum/testing`](packages/testing) | Testing utilities | 3 |

## Documentation

- **[Full Documentation](https://github.com/Connectum-Framework/docs)** - All documentation sections
- **[Quick Start](https://github.com/Connectum-Framework/docs/blob/main/guide/getting-started/quick-start.md)** - Create your first service in 5 minutes
- **[Migration from @labeling/utils](https://github.com/Connectum-Framework/docs/blob/main/guide/migration/from-labeling-utils.md)** - Migration guide
- **[Architecture Decision Records](https://github.com/Connectum-Framework/docs/blob/main/contributing/adr/)** - Architectural decisions
- **[API Reference](https://github.com/Connectum-Framework/docs/blob/main/guide/api/)** - Full API documentation

## Architecture

```
Layer 0: Independent Core
  ├── proto           # Proto definitions
  └── otel            # OpenTelemetry

Layer 1: Protocol Implementations
  └── interceptors    # ConnectRPC interceptors

Layer 2: Integration
  └── core            # Main server factory + protocols

Layer 3: Development Tools
  └── testing         # Testing utilities
```

More details: [Architecture Overview](https://github.com/Connectum-Framework/docs/blob/main/contributing/architecture/overview.md)

## Server API

### createServer()

Main factory function for creating a server:

```typescript
import { createServer } from '@connectum/core';

const server = createServer({
  // Required: service routes
  services: [myRoutes],

  // Server config
  port: 5000,              // Default: 5000
  host: '0.0.0.0',         // Default: 0.0.0.0

  // TLS (optional)
  tls: {
    keyPath: './keys/server.key',
    certPath: './keys/server.crt',
  },

  // Health check (optional)
  health: {
    enabled: true,         // gRPC health check
    httpEnabled: true,     // HTTP /healthz endpoint
    httpPath: '/healthz',  // Custom path
  },

  // Graceful shutdown (optional)
  shutdown: {
    autoShutdown: true,    // Auto handle SIGTERM/SIGINT
    timeout: 30000,        // Shutdown timeout
    signals: ['SIGTERM', 'SIGINT'],
  },

  // Custom interceptors
  interceptors: [myInterceptor],

  // Server reflection
  reflection: true,        // Default: true
});
```

### Server Interface

```typescript
interface Server extends EventEmitter {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // State
  readonly address: AddressInfo | null;
  readonly isRunning: boolean;
  readonly state: ServerState;  // 'created' | 'starting' | 'running' | 'stopping' | 'stopped'

  // Health management
  readonly health: HealthcheckManager;

  // Events: 'start', 'ready', 'stop', 'error'
}
```

### Lifecycle Hooks

```typescript
server.on('start', () => {
  // Server is starting up
});

server.on('ready', () => {
  // Server is ready to accept connections
  server.health.update(ServingStatus.SERVING);
});

server.on('stop', () => {
  // Server has stopped
});

server.on('error', (error: Error) => {
  // Server error
  console.error(error);
});
```

## Examples

Usage examples are maintained in a separate repository: **[Connectum-Framework/examples](https://github.com/Connectum-Framework/examples)**

- **basic-service** - minimal greeter service
- **performance-test-server** - server for k6 benchmarks
- **production-ready** - production deployment template (WIP)
- **with-custom-interceptor** - custom interceptors example (WIP)

## Development

### Environment Setup

```bash
# Clone the repository
git clone https://github.com/Connectum-Framework/connectum.git
cd connectum

# Install dependencies
pnpm install

# Generate proto files
pnpm run build:proto

# Run tests
pnpm test
```

More details: [Development Setup](https://github.com/Connectum-Framework/docs/blob/main/contributing/development/development-setup.md)

### Repository Structure

```
connectum/
├── packages/          # 5 framework packages
└── .husky/            # Git hooks (commitlint, biome)
```

Related repositories:
- **[docs](https://github.com/Connectum-Framework/docs)** - Documentation
- **[examples](https://github.com/Connectum-Framework/examples)** - Usage examples

## Project Status

**Current release**: v0.2.0-alpha.2 (Alpha)

### Completed

- Native TypeScript support (Node.js 25.2.0+)
- 5-package modular architecture
- New createServer() API with explicit lifecycle
- OpenTelemetry instrumentation
- gRPC Health Check Protocol
- gRPC Server Reflection
- ConnectRPC interceptors (validation, tracing, logging, etc.)
- Resilience interceptors (circuit breaker, timeout, bulkhead, fallback)
- Comprehensive documentation

### In Progress

- Beta testing with real services
- Additional examples
- Plugin system

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md)

### Quick Links

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Development Setup](https://github.com/Connectum-Framework/docs/blob/main/contributing/development/development-setup.md)
- [Architecture Decision Records](https://github.com/Connectum-Framework/docs/blob/main/contributing/adr/)

## License

Apache License 2.0 - see [LICENSE](LICENSE) file for details.

## Acknowledgments

Connectum is an evolution of [@labeling/utils](https://github.com/AnyLabel/Integrity), redesigned as a universal framework.

---

**Connectum** - universal framework for production-ready gRPC/ConnectRPC microservices on Node.js 25+.

Built with care by [Highload.Zone](https://highload.zone)

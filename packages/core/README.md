# @connectum/core

Main Server factory with protocol plugin system for Connectum.

**@connectum/core** is the main integration layer package that combines all Connectum components for building production-ready ConnectRPC/gRPC services.

## Features

- **createServer()**: Factory function for creating a server with explicit lifecycle
- **Lifecycle Hooks**: Events start, ready, stop, error
- **Protocol Plugin System**: Extensible system via `protocols: []` array
- **TLS Configuration**: Utilities for configuring TLS certificates
- **Graceful Shutdown**: Built-in graceful shutdown support with automatic signal handling
- **Explicit Interceptors**: User passes interceptors explicitly (zero internal deps)
- **Standalone Catalog Client** _(since 1.1.0)_: `createCatalogClient()` — the catalog-typed `call`/`stream` surface usable OUTSIDE a `Server` (a Temporal worker, scheduler, or CLI)

### Protocol Packages (installed separately)

- **@connectum/healthcheck**: [gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) + HTTP endpoints
- **@connectum/reflection**: [gRPC Server Reflection](https://github.com/grpc/grpc/blob/master/doc/server-reflection.md)

## Installation

```bash
pnpm add @connectum/core
```

**Peer dependencies:** `@bufbuild/protobuf` `^2.16.0`, `@connectrpc/connect` `^2.2.0` and `@connectrpc/connect-node` `^2.2.0`. npm 7+, pnpm and Bun install missing peers automatically; Yarn does not, so add them yourself:

```bash
yarn add @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node
```

Your application and every Connectum package share one copy of each library. If you pin them, keep the pins inside these ranges and `connect` / `connect-node` on the same version: npm refuses an out-of-range pin with `ERESOLVE`, pnpm and Bun warn. Whatever the package manager, `createServer()` checks the copies it loaded and throws `PeerDependencyVersionError` — naming the package, the loaded version, the required range and the fix — when one is outside its range, or when `@connectrpc/connect-node` runs with a `@connectrpc/connect` other than the exact version it declares. The check is skipped when `@connectum/core` is bundled into your application, because a bundle carries no package metadata to read. See [Peer dependencies on protobuf and Connect](https://connectum.dev/en/migration/peer-dependencies).

## Quick Start

### Minimal Example

```typescript
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
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { Reflection } from '@connectum/reflection';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
  shutdown: {
    autoShutdown: true,  // Graceful shutdown on SIGTERM/SIGINT
    timeout: 30000,
  },
});

// Lifecycle hooks
server.on('ready', () => {
  console.log(`Server ready on port ${server.address?.port}`);
  healthcheckManager.update(ServingStatus.SERVING);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

await server.start();
```

### With TLS

```typescript
import { createServer } from '@connectum/core';

const server = createServer({
  services: [routes],
  port: 5000,
  tls: {
    keyPath: './keys/server.key',
    certPath: './keys/server.crt',
  },
});

await server.start();
```

## Internal Architecture

The `@connectum/core` module is split into independent submodules, each responsible for its own domain:

```
core/src/
├── Server.ts            # Orchestrator: lifecycle state machine, EventEmitter
├── TransportManager.ts  # HTTP/2 transport: creation, listen, session tracking
├── buildRoutes.ts       # Composition: services + protocols + interceptors -> handler
├── errors.ts            # SanitizableError protocol and type guard
├── gracefulShutdown.ts  # Graceful shutdown: timeout race, force close, hooks
├── ShutdownManager.ts   # Shutdown hooks: dependency ordering, cycle detection
├── TLSConfig.ts         # TLS: certificate reading, path resolution
├── types.ts             # Public types and interfaces
└── index.ts             # Re-exports
```

### TransportManager

Manages the HTTP/2 server lifecycle:
- Creating secure/plaintext HTTP/2 server
- Tracking active `Http2Session` instances for forced termination on timeout
- Listen with proper error handling (error listener cleanup)
- Graceful close (sending GOAWAY)
- Force destroy of all sessions

### buildRoutes

Route and protocol composition:
- Registering user services on `ConnectRouter`
- Intercepting `router.service()` to collect `DescFile[]` registry (used by reflection)
- Setting up each protocol (healthcheck, reflection) once per server with a snapshot of the registry, then registering its routes on every router the server builds (HTTP adapter and each in-process transport)
- Creating `connectNodeAdapter` with fallback routing to HTTP protocol handlers, and the server-level `requestGate` / `readMaxBytes` defaults when set
- Removing a forged `connectum-internal-transport` header from each HTTP request before the adapter sees it

### gracefulShutdown

Orchestration of graceful shutdown through a sequence of phases:
1. **Close transport** -- send GOAWAY, stop accepting new connections
2. **Timeout race** -- wait for in-flight requests to complete or timeout
3. **Force close** -- on timeout, destroy all HTTP/2 sessions (if `forceCloseOnTimeout: true`)
4. **Execute hooks** -- run all shutdown hooks (even after timeout)
5. **Dispose** -- clean up internal state

Errors in `Promise.race` are properly caught, timer is cleared via `clearTimeout` in `finally`.

## API Reference

### createServer()

Main factory function for creating a server:

```typescript
import { createServer } from '@connectum/core';

function createServer(options: CreateServerOptions): Server
```

**Parameters (`CreateServerOptions`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `services` | `ServiceDefinition[]` | required | Service definitions (use `defineService()` / `defineLazyService()`) |
| `port` | `number` | `5000` | Server port |
| `host` | `string` | `'0.0.0.0'` | Host to bind |
| `tls` | `TLSOptions` | - | TLS configuration |
| `protocols` | `ProtocolRegistration[]` | `[]` | Protocol plugins (healthcheck, reflection) |
| `shutdown` | `ShutdownOptions` | - | Graceful shutdown configuration |
| `interceptors` | `Interceptor[]` | `[]` | ConnectRPC interceptors (use `createDefaultInterceptors()` from `@connectum/interceptors`) |
| `allowHTTP1` | `boolean` | `true` | Allow HTTP/1.1 connections |
| `handshakeTimeout` | `number` | `30000` | Handshake timeout (ms) |
| `http2Options` | `SecureServerOptions` | - | Additional HTTP/2 options |
| `requestGate` | `(context: HandlerContext) => void \| Promise<void>` | - | Server-wide Connect request gate: runs before the request body is read; throw a `ConnectError` to reject. See [Request admission](#request-admission) |
| `readMaxBytes` | `number` | Connect default (~4 GiB) | Server-wide per-message read limit; larger messages end with `ResourceExhausted`. See [Request admission](#request-admission) |

**Returns:** `Server` - server instance (not started)

### Server Interface

```typescript
interface Server extends EventEmitter {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // State
  readonly address: AddressInfo | null;
  readonly isRunning: boolean;
  readonly state: ServerState;

  // Transport access
  readonly transport: HttpServer | Http2Server | Http2SecureServer | null;
  readonly routes: ReadonlyArray<ServiceDefinition>;
  readonly interceptors: ReadonlyArray<Interceptor>;
  readonly protocols: ReadonlyArray<ProtocolRegistration>;

  // Shutdown signal (aborted when server begins shutdown)
  readonly shutdownSignal: AbortSignal;

  // Runtime operations (only before start())
  addService(service: ServiceDefinition): void;
  addInterceptor(interceptor: Interceptor): void;
  addProtocol(protocol: ProtocolRegistration): void;

  // Shutdown hooks
  onShutdown(handler: ShutdownHook): void;
  onShutdown(name: string, handler: ShutdownHook): void;
  onShutdown(name: string, dependencies: string[], handler: ShutdownHook): void;

  // Events
  on(event: 'start', listener: () => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'stopping', listener: () => void): this;
  on(event: 'stop', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}
```

### Lifecycle Hooks

```typescript
import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';

// Server is starting up
server.on('start', () => {
  console.log('Server starting...');
});

// Server is ready to accept connections
server.on('ready', () => {
  console.log(`Listening on port ${server.address?.port}`);
  healthcheckManager.update(ServingStatus.SERVING);
});

// Server begins graceful shutdown (before abort signal)
server.on('stopping', () => {
  console.log('Server shutting down...');
  healthcheckManager.update(ServingStatus.NOT_SERVING);
});

// Server has stopped
server.on('stop', () => {
  console.log('Server stopped');
});

// Server error (instead of process.exit)
server.on('error', (error: Error) => {
  console.error('Server error:', error);
});
```

**Important**: The server emits an `error` event instead of calling `process.exit(1)`. This allows the application to decide how to handle fatal errors on its own.

### ServerState

```typescript
const ServerState = {
  CREATED: 'created',    // Server created, not started
  STARTING: 'starting',  // Server is starting
  RUNNING: 'running',    // Server is running
  STOPPING: 'stopping',  // Server is stopping
  STOPPED: 'stopped',    // Server has stopped
} as const;

type ServerState = typeof ServerState[keyof typeof ServerState];
```

### Health Check (via @connectum/healthcheck)

Health check protocol is available as a separate package:

```typescript
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';

const server = createServer({
  services: [routes],
  protocols: [Healthcheck({ httpEnabled: true })],
});

server.on('ready', () => {
  // Update overall service health
  healthcheckManager.update(ServingStatus.SERVING);

  // Update specific service health
  healthcheckManager.update(ServingStatus.SERVING, 'my.service.Name');
});
```

See `@connectum/healthcheck` package for full documentation.

### TLS Utilities

```typescript
import { getTLSPath, readTLSCertificates, tlsPath } from '@connectum/core';

// Get TLS path from environment
const path = getTLSPath();

// Read TLS certificates
const { key, cert } = readTLSCertificates({
  keyPath: './keys/server.key',
  certPath: './keys/server.crt',
});

// Configured TLS path (eagerly resolved string constant — use as a value, not a call)
const configuredPath = tlsPath;
```

### SanitizableError Protocol

`SanitizableError` is an interface for errors that carry server-side diagnostic details while exposing only a safe message to clients. The `@connectum/interceptors` error handler recognizes this interface and sanitizes errors automatically.

**Interface:**

```typescript
interface SanitizableError {
  readonly clientMessage: string;
  readonly serverDetails: Readonly<Record<string, unknown>>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `clientMessage` | `string` | Safe message sent to the client |
| `serverDetails` | `Readonly<Record<string, unknown>>` | Rich diagnostic details logged server-side |
| `code` | `number` | Numeric gRPC/Connect status code (e.g., `Code.FailedPrecondition`) |

**Type guard:**

```typescript
function isSanitizableError(err: unknown): err is Error & SanitizableError & { code: number }
```

Returns `true` when `err` is an `instanceof Error` with a `clientMessage` string, a non-null `serverDetails` object, and a numeric `code`. Plain objects that are not `Error` instances will **not** pass the check -- errors must extend `Error` and carry a numeric `code` property.

**Usage example:**

```typescript
import type { SanitizableError } from '@connectum/core';
import { Code } from '@connectrpc/connect';

class PaymentError extends Error implements SanitizableError {
  readonly code = Code.FailedPrecondition;
  readonly clientMessage: string;
  readonly serverDetails: Readonly<Record<string, unknown>>;

  constructor(reason: string, details: Record<string, unknown>) {
    super(reason);
    this.clientMessage = 'Payment processing failed';
    this.serverDetails = details;
  }
}

// Throwing this error inside a ConnectRPC handler:
// - Client receives: ConnectError with message "Payment processing failed"
// - Server logs: full serverDetails object for debugging
throw new PaymentError('Stripe declined', { stripeCode: 'card_declined', amount: 4999 });
```

### createCatalogClient()

_Available since 1.1.0._

A standalone, catalog-typed client that exposes the **same** typed `call` (unary) and `stream` (server/client/bidi) surface as the in-handler `ctx.call` / `ctx.stream`, but usable **outside** a `Server` — in a Temporal worker, a scheduler, or a CLI — without constructing a server:

```typescript
import { createCatalogClient, type CreateCatalogClientOptions } from '@connectum/core';

function createCatalogClient(options: CreateCatalogClientOptions): CatalogClient
```

**Parameters (`CreateCatalogClientOptions`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `catalog` | `ServiceCatalog` | required | The service catalog backing typed dispatch — the same object passed to `createServer({ catalog })` |
| `resolver` | `RemoteResolver` | required | Resolves every target's transport (`singleTransportResolver` / `mapResolver` / `dnsResolver` / `perServiceEnvResolver`) |

**Returns:** `CatalogClient` — `{ call, stream }`, keyed off the generated `ConnectumCallMap` / `ConnectumStreamMap`.

The dispatch is typed off the generated catalog, so calls are statically checked exactly as on the handler `ctx`:

```typescript
import { createCatalogClient, mapResolver } from '@connectum/core';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { serviceCatalog } from '#gen/catalog.js'; // from @connectum/protoc-gen-catalog

const client = createCatalogClient({
  catalog: serviceCatalog,
  resolver: mapResolver({
    'trip.v1.TripService': createGrpcTransport({ baseUrl: process.env.TRIP_ADDR ?? 'http://localhost:8080' }),
  }),
});

// Fully typed off the generated catalog — same surface as ctx.call:
const trip = await client.call('trip.v1.TripService/StartTrip', { vehicleId: 'veh-42' });
```

**Resolution & caching:** every target is routed through the supplied `RemoteResolver`, and the resolved transport is cached per `(typeName, endpoint)`. There is **no** in-process/local path: a service the resolver cannot resolve fails with `Code.Unavailable`. The rest of the error model mirrors `ctx.call` — unknown service/method (or wrong method kind) fails with `Code.Unimplemented`, and a resolver that throws surfaces as `Code.Internal` (cause preserved).

**Difference from `ctx.call`:** there is no inbound request to cascade from, so `CallOptions` are applied **verbatim** — the `signal` / `timeoutMs` are **not** cascaded or clamped, no inbound headers are propagated, and no `ContextValues` are forwarded.

## Exports Summary

| Export | Kind | Description |
|--------|------|-------------|
| `createServer` | function | Factory function for creating a server |
| `ServerState` | const | Server lifecycle states |
| `LifecycleEvent` | const | Lifecycle event names |
| `SanitizableError` | type | Interface for errors with safe client messages and server details |
| `isSanitizableError` | function | Type guard for `SanitizableError` |
| `getTLSPath` | function | Get TLS path from environment |
| `readTLSCertificates` | function | Read TLS key and certificate files |
| `tlsPath` | const | Configured TLS path (eagerly resolved string) |
| `parseEnvConfig` | function | Parse environment configuration (throws on invalid) |
| `safeParseEnvConfig` | function | Parse environment configuration (returns result) |
| `ConnectumEnvSchema` | const | Zod schema for environment variables |
| `LogLevelSchema` | const | Zod schema for log level |
| `LogFormatSchema` | const | Zod schema for log format |
| `LoggerBackendSchema` | const | Zod schema for logger backend |
| `NodeEnvSchema` | const | Zod schema for NODE_ENV |
| `BooleanFromStringSchema` | const | Zod schema for boolean-from-string coercion |
| `Server` | type | Server interface |
| `CreateServerOptions` | type | Options for `createServer()` |
| `ProtocolRegistration` | type | Protocol plugin interface |
| `ShutdownOptions` | type | Graceful shutdown options |
| `TLSOptions` | type | TLS configuration options |
| `ServiceDefinition` | type | A mountable service: descriptor + register closure (from `defineService`) |
| `ShutdownHook` | type | Shutdown hook function type |
| `HttpHandler` | type | HTTP handler type |
| `ProtocolContext` | type | Protocol context type |
| `ConnectumEnv` | type | Environment configuration type |

### Service catalog & transport

| Export | Kind | Description |
|--------|------|-------------|
| `defineService` | function | Define a mountable service from a descriptor + register closure |
| `defineLazyService` | function | Define a service whose implementation is resolved lazily, once per server (shared by HTTP, `localClient` and `ctx.call`) |
| `defineCatalog` | function | Build a typed `ServiceCatalog` for cross-service calls |
| `mergeCatalogs` | function | Merge multiple catalogs into one |
| `CatalogConfigError` | class | Error thrown for invalid catalog configuration |
| `createCatalogClient` | function | Standalone, catalog-typed `call` / `stream` client usable outside a `Server` (since 1.1.0) |
| `CreateCatalogClientOptions` | type | Options for `createCatalogClient()` (`catalog` + `resolver`) |
| `CatalogClient` | type | The standalone catalog client returned by `createCatalogClient()` (`call` + `stream`) |
| `createLocalTransport` | function | Create an in-process transport for same-process service calls |
| `CreateLocalTransportOptions` | type | Options for `createLocalTransport()` (client-side interceptors) |
| `defaultPropagateHeaders` | const | Ready-made opt-in allow-list of W3C trace-context headers for `createServer({ propagateHeaders })` (nothing propagates by default) |
| `dnsResolver` | function | Remote resolver that builds per-service targets from a DNS-style URL template |
| `DnsResolverOptions` | type | Options for `dnsResolver()` (URL template, transport factory) |
| `mapResolver` | function | Remote resolver backed by a static service→target map |
| `perServiceEnvResolver` | function | Remote resolver reading per-service targets from env |
| `PerServiceEnvResolverOptions` | type | Options for `perServiceEnvResolver()` (transport factory) |
| `singleTransportResolver` | function | Remote resolver returning one transport for all services |
| `resolveEffectiveTransport` | function | Resolve the effective transport (`plaintext-h1` / `h2c` / `tls-h1-negotiable` / `tls-h2-only`) from `tls` + `allowHTTP1` |
| `TransportValidationError` | class | Error for bidi-streaming methods unsupported by the effective transport |
| `TRANSPORT_VALIDATION_ERROR_CODE` | const | Error code for `TransportValidationError` |
| `TransportValidationMode` | const | Transport validation mode values |
| `EffectiveTransport` | const | Effective transport values |
| `Context` | type | Handler context exposing `ctx.call` / `ctx.stream` |
| `CallOptions` | type | Options for a `ctx.call` cross-service call |
| `ServiceOptions` | type | Per-service options for `defineService()` |
| `RemoteResolver` | type | Interface for resolving remote service transports |
| `ResolverContext` | type | Context passed to a `RemoteResolver` |
| `ServiceCatalog` | type | Typed registry of callable services |
| `ConnectumCallMap` | type | Augmentable map of unary cross-service calls |
| `ConnectumStreamMap` | type | Augmentable map of streaming cross-service calls |
| `BidiStreamHandle` | type | Handle for a bidirectional stream from `ctx.stream` |
| `ClientStreamHandle` | type | Handle for a client stream from `ctx.stream` |

## Configuration Types

### ShutdownOptions

```typescript
interface ShutdownOptions {
  /** Timeout in milliseconds for graceful shutdown (default: 30000) */
  timeout?: number;

  /** Signals to listen for graceful shutdown (default: ['SIGTERM', 'SIGINT']) */
  signals?: NodeJS.Signals[];

  /** Enable automatic graceful shutdown on signals (default: false) */
  autoShutdown?: boolean;

  /**
   * Force close all HTTP/2 sessions when shutdown timeout is exceeded.
   * When true, sessions are destroyed after timeout.
   * When false, server waits indefinitely for in-flight requests to complete.
   * (default: true)
   */
  forceCloseOnTimeout?: boolean;
}
```

#### Graceful Shutdown Behavior

When `server.stop()` is called or a signal is received (with `autoShutdown: true`):

1. The `stopping` event is emitted -- healthcheck can be updated to NOT_SERVING
2. `AbortController.abort()` -- aborts `context.signal` of every in-flight RPC, over HTTP and in-process (`server.localClient()`, `ctx.call`), so handlers and streams can terminate
3. Transport sends GOAWAY and stops accepting new connections
4. **Timeout race**: waits for in-flight HTTP requests to complete or for `timeout` to expire. In-process calls ride no connection, so `stop()` neither waits for them nor force-closes them; a handler that ignores the signal keeps running
5. On timeout with `forceCloseOnTimeout: true` -- forcefully destroys all HTTP/2 sessions
6. Executes shutdown hooks (respecting dependencies)
7. Cleans up internal state

Repeated calls to `stop()` are safe -- they return the same Promise as the first call.

### TLSOptions

```typescript
interface TLSOptions {
  /** Path to TLS key file */
  keyPath?: string;

  /** Path to TLS certificate file */
  certPath?: string;

  /** TLS directory path (alternative to keyPath/certPath) */
  dirPath?: string;
}
```

### Interceptors

`@connectum/core` does not include built-in interceptors. Use `@connectum/interceptors` for a production-ready chain (errorHandler + validation by default; resilience interceptors such as timeout, bulkhead, circuitBreaker, retry are opt-in):

```typescript
import { createDefaultInterceptors } from '@connectum/interceptors';

const server = createServer({
  services: [routes],
  // Defaults to errorHandler + validation only. Enable resilience explicitly:
  interceptors: createDefaultInterceptors({ timeout: true, retry: true }),
});
```

See `@connectum/interceptors` package for `DefaultInterceptorOptions` and full documentation.

### Request admission

Two opt-in options reject a request before its body is read. Both are unset by default.

```typescript
import { Code, ConnectError } from '@connectrpc/connect';

const server = createServer({
  services: [routes],
  // Runs after the headers arrive, before any message is received or parsed.
  requestGate: (context) => {
    if (!context.requestHeader.get('authorization')) {
      throw new ConnectError('unauthenticated', Code.Unauthenticated);
    }
  },
  // Per request message; larger messages end with Code.ResourceExhausted.
  readMaxBytes: 1024 * 1024,
});
```

What to rely on:

- **Both transports.** The gate and the limit apply identically over HTTP and in-process (`server.localClient()`, `createLocalTransport()`, `ctx.call` to a local service). There is no in-process exemption: an internal `ctx.call` carries only the headers you forward with `propagateHeaders` or `outgoingInterceptors`.
- **Safe errors.** A gate runs before the server interceptors, so `errorHandler` never sees its error. A thrown `ConnectError` reaches the client as thrown: give it a fixed, client-safe message. Anything else is replaced by Connect with `internal error` (`Code.Internal`), so its text never reaches the client.
- **Valid limits only.** `readMaxBytes` must be an integer from 1 to 4294967295; `createServer()` throws a `RangeError` naming the option otherwise.
- **No server-side telemetry.** A rejected call runs no server interceptor, so it produces no server span, metric or log entry. To audit rejections, wrap the gate: catch, record, rethrow.
- **Defaults, not ceilings.** A service's own `requestGate` or `readMaxBytes` in `ServiceOptions` replaces the server value for that service.
- **Coverage.** Every RPC on the router is gated, including gRPC Health and Reflection. HTTP endpoints served by protocol HTTP handlers, such as `/healthz`, are not.
- **Cancellation.** A pending gate is awaited. `context.signal` aborts on the deadline, on client cancellation, and when `server.stop()` begins — on both transports.

The request's `connectum-internal-transport` header is removed from HTTP requests before any gate runs, so a remote caller cannot forge the in-process marker.

The full guide is [Request admission](https://connectum.dev/en/guide/security/request-admission).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `LISTEN` | Server host | `0.0.0.0` |
| `TLS_DIR_PATH` | Directory containing the TLS key + cert (`server.key`/`server.crt`) that `tlsPath` resolves | - |
| `NODE_ENV` | Environment (affects logger) | - |

## Examples

### Minimal Service

```typescript
import { createServer } from '@connectum/core';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
});

await server.start();
console.log(`Server running on ${server.address?.port}`);
```

### Production Service with All Features

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { createDefaultInterceptors } from '@connectum/interceptors';
import { Reflection } from '@connectum/reflection';
import routes from '#gen/routes.js';

// Build protocols list
const protocols = [Healthcheck({ httpEnabled: true })];
if (process.env.NODE_ENV !== 'production') {
  protocols.push(Reflection());
}

const server = createServer({
  services: [routes],
  port: process.env.PORT ? Number(process.env.PORT) : 5000,
  host: '0.0.0.0',
  protocols,

  // TLS for production
  tls: process.env.NODE_ENV === 'production' ? {
    keyPath: './keys/server.key',
    certPath: './keys/server.crt',
  } : undefined,

  // Graceful shutdown
  shutdown: {
    autoShutdown: true,
    timeout: 30000,
    signals: ['SIGTERM', 'SIGINT'],
  },

  // Interceptors (explicit — core has no built-in interceptors)
  interceptors: createDefaultInterceptors({
    errorHandler: { logErrors: true },
    timeout: { duration: 30_000 },
  }),
});

// Lifecycle hooks
server.on('start', () => {
  console.log('Server starting...');
});

server.on('ready', () => {
  console.log(`Server ready on ${server.address?.port}`);
  healthcheckManager.update(ServingStatus.SERVING);
});

server.on('stop', () => {
  console.log('Server stopped');
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

// Start server
await server.start();
```

### Manual Graceful Shutdown

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck()],
  // Note: autoShutdown: false (default)
});

server.on('ready', () => {
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();

// Manual shutdown handlers
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM');

  // Mark as not serving (drain connections)
  healthcheckManager.update(ServingStatus.NOT_SERVING);

  // Wait for connections to drain
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Stop server
  await server.stop();

  process.exit(0);
});
```

### Adding Services at Runtime

```typescript
import { createServer } from '@connectum/core';

const server = createServer({
  services: [mainRoutes],
  port: 5000,
});

// Add more services before starting
server.addService(adminRoutes);
server.addService(metricsRoutes);

await server.start();

// Note: Cannot add services after start()
```

## Dependencies

### Internal Dependencies

None — `@connectum/core` is Layer 0 with zero internal dependencies.

### External Dependencies

- `@connectrpc/connect` - ConnectRPC core
- `@connectrpc/connect-node` - Node.js adapter
- `@bufbuild/protobuf` - Protocol Buffers runtime
- `env-var` - Environment variables management
- `zod` - Environment configuration schema validation

## Requirements

- **Node.js**: >=22.13.0
- **pnpm**: >=11.0.0
- **TypeScript**: >=5.7.2 (for type checking)

### Alternative Runtimes

`@connectum/core` ships compiled JavaScript and type declarations, so it works on any Node.js 22+ without additional configuration. Your own `.ts` source files can be executed with:

- **Node.js 22.6--22.17** -- native type stripping (experimental). Run `node --experimental-strip-types src/index.ts`.
- **Node.js 22.18+** -- native type stripping enabled by default. Run `node src/index.ts`.
- **Bun** -- built-in TypeScript support. Run `bun src/index.ts`.
- **[tsx](https://tsx.is)** -- esbuild-powered TypeScript execution, works on Node.js 22+. Run `npx tsx src/index.ts`.

## Documentation

### Getting Started

- [Quick Start](https://connectum.dev/en/guide/quickstart) - Create your first service

### Architecture

- [Architecture Overview](https://connectum.dev/en/guide/production/architecture) - Overall architecture
- [Package Decomposition](https://connectum.dev/en/contributing/adr/003-package-decomposition) - ADR on package structure

### Guides

- [Interceptors Guide](https://connectum.dev/en/guide/interceptors) - Working with interceptors
- [Observability Guide](https://connectum.dev/en/guide/observability) - Setting up OpenTelemetry
- [TLS Configuration](https://connectum.dev/en/guide/security/tls) - Production TLS setup
- [Request Admission](https://connectum.dev/en/guide/security/request-admission) - Reject requests before the body is read

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** — Universal framework for production-ready gRPC/ConnectRPC microservices

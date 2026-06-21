# @connectum/healthcheck

gRPC Health Check Protocol + HTTP health endpoints for Connectum.

**@connectum/healthcheck** implements the [gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) with additional HTTP endpoints for Kubernetes liveness/readiness probes.

## Features

- **gRPC Health Check Protocol**: Check, Watch methods ([standard](https://github.com/grpc/grpc/blob/master/doc/health-checking.md)) + List (extension)
- **HTTP Health Endpoints**: `/healthz`, `/health`, `/readyz` (configurable paths)
- **Per-service Health Status**: Manage the status of each service separately
- **Watch Streaming**: Real-time status change streaming
- **Factory Pattern**: `createHealthcheckManager()` for isolated instances
- **Singleton by Default**: Global `healthcheckManager` for simple scenarios

## Installation

```bash
pnpm add @connectum/healthcheck
```

**Peer dependency:**

```bash
pnpm add @connectum/core
```

## Quick Start

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
import routes from '#gen/routes.js';

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck({ httpEnabled: true })],
});

server.on('ready', () => {
  // Marks every registered RPC service SERVING. For apps that also track
  // independent components (e.g. `amqp`), update those addressably via
  // `set(component, status)` instead — see "Services vs components" below.
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();
```

## API Reference

### Healthcheck(options?)

Factory function that creates a `ProtocolRegistration` for use with `createServer()`.

```typescript
import { Healthcheck } from '@connectum/healthcheck';

const protocol = Healthcheck({
  httpEnabled: true,
  httpPaths: ['/healthz', '/health', '/readyz'],
  watchInterval: 500,
  manager: customManager,  // optional
});
```

**Parameters (`HealthcheckOptions`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `httpEnabled` | `boolean` | `false` | Enable HTTP health endpoints |
| `httpPaths` | `string[]` | `["/healthz", "/health", "/readyz"]` | HTTP health endpoint paths |
| `watchInterval` | `number` | `500` | Polling interval for Watch streaming (ms) |
| `manager` | `HealthcheckManager` | `healthcheckManager` (singleton) | Custom manager (for tests or multi-server) |

### healthcheckManager (singleton)

Global singleton instance of `HealthcheckManager`. Can be imported from any file in the application:

```typescript
import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';

// Update status of all services
healthcheckManager.update(ServingStatus.SERVING);

// Update status of a specific service
healthcheckManager.update(ServingStatus.NOT_SERVING, 'my.service.v1.MyService');
```

### createHealthcheckManager()

Factory function for creating an isolated `HealthcheckManager`. Useful for testing or running multiple servers in a single process.

```typescript
import { Healthcheck, createHealthcheckManager, ServingStatus } from '@connectum/healthcheck';
import { createServer } from '@connectum/core';

const manager = createHealthcheckManager();

const server = createServer({
  services: [routes],
  protocols: [Healthcheck({ httpEnabled: true, manager })],
});

server.on('ready', () => {
  manager.update(ServingStatus.SERVING);
});

await server.start();
```

### HealthcheckManager

Class for managing service health statuses.

#### Methods

| Method | Description |
|--------|-------------|
| `update(status, service?)` | Update status. Without `service` -- updates **all** registered entries, **including components** (see note below). Throws on unknown names. |
| `register(component, initialStatus?)` | Register an application health component (default `UNKNOWN`). Re-registering preserves the current status. |
| `set(component, status)` | Set a component's status (upsert: registers the component if absent). |
| `unregister(component)` | Remove a registered component. |
| `getStatus(service)` | Get the status of a specific service or component. Returns `ServiceStatus \| undefined` (`undefined` for an unknown name -- it does not throw, unlike `update()`). |
| `getAllStatuses()` | Get a Map of all statuses |
| `areAllHealthy()` | Check if all services and components are in SERVING status |
| `initialize(serviceNames)` | Initialize RPC service tracking (called by the protocol) |
| `clear()` | Clear all services and components |

#### Services vs components

The registry tracks two kinds of entries:

- **Services** -- Connect RPC services, owned by the Healthcheck protocol.
  `initialize()` adds, preserves, and removes these on server start.
- **Components** -- application-defined readiness gates (`process`, `amqp`,
  a database connection, ...), owned by the application via
  `register()`/`set()`/`unregister()`. `initialize()` never touches them.

Component names must be non-empty and dot-free: conventionally packaged proto
service typeNames are dotted, so the two namespaces do not collide (a kind
check guards the rare package-less service). A registered component is
a readiness gate -- it participates in `areAllHealthy()`, gRPC `Check`/`Watch`
(queryable by name), and `/healthz` exactly like a service.

> **Note on `update(status)` without a service name:** it overwrites **every**
> registered entry, components included. In a mixed app (RPC services plus an
> independently managed component such as `amqp`), a blanket
> `healthcheckManager.update(SERVING)` on `ready` would mask a real component
> failure. Update independently managed components addressably via
> `set(component, status)` instead.

#### initialize() Behavior

`initialize()` replaces only the **service slice** of the registry:
- Services already registered retain their current status
- New services are added with `UNKNOWN` status
- Services absent from the new list are removed (active `Watch` streams on
  them observe `SERVICE_UNKNOWN`)
- Components are never touched

#### Workers without RPC

A worker with no public RPCs (`services: []`) can never become SERVING through
the service registry -- the registry is empty and `/healthz` answers 503
permanently. Register a process component instead; registration works before
or after `server.start()`:

```typescript
import { createServer } from '@connectum/core';
import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';

const server = createServer({
  services: [],            // poller / publisher / exporter — no public RPCs
  protocols: [Healthcheck({ httpEnabled: true })],
});

healthcheckManager.register('process');  // UNKNOWN until ready

server.on('ready', () => healthcheckManager.set('process', ServingStatus.SERVING));
server.on('stopping', () => healthcheckManager.set('process', ServingStatus.NOT_SERVING));

await server.start();
// docker-compose `service_healthy` gating now works: /healthz → 200 when ready
```

### ServingStatus

Status values (correspond to the gRPC Health Check Protocol):

| Status | Value | Description |
|--------|-------|-------------|
| `UNKNOWN` | `0` | Status unknown |
| `SERVING` | `1` | Service is running normally |
| `NOT_SERVING` | `2` | Service is unavailable |
| `SERVICE_UNKNOWN` | `3` | Requested service not found |

## HTTP Health Endpoints

When `httpEnabled: true`, HTTP endpoints are available that mirror the gRPC healthcheck status.

**Default paths:** `/healthz`, `/health`, `/readyz`

Can be configured via `httpPaths`:

```typescript
Healthcheck({
  httpEnabled: true,
  httpPaths: ['/healthz', '/ready', '/live'],
})
```

### Response Format

```json
{
  "status": "SERVING",
  "service": "overall",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### HTTP Status Codes

| ServingStatus | HTTP Code |
|---------------|-----------|
| `SERVING` | `200 OK` |
| `NOT_SERVING` | `503 Service Unavailable` |
| `SERVICE_UNKNOWN` | `404 Not Found` |
| `UNKNOWN` | `503 Service Unavailable` |

### Checking a Specific Service

```bash
curl http://localhost:5000/healthz?service=my.service.v1.MyService
```

## gRPC Methods

### Health.Check

Check the health of a specific service:

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Check
```

With a specific service:

```bash
grpcurl -plaintext -d '{"service": "my.service.v1.MyService"}' \
  localhost:5000 grpc.health.v1.Health/Check
```

### Health.Watch

Stream status changes (gRPC server streaming):

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Watch
```

Behavior per gRPC specification:
- Immediately sends current status
- Sends updates only on status changes
- For unknown services: sends `SERVICE_UNKNOWN` (does not terminate the call)
- Terminates on client disconnect (AbortSignal)

### Health.List

List all services with their statuses:

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/List
```

## Examples

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 5000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readyz
    port: 5000
  initialDelaySeconds: 3
  periodSeconds: 5
```

### Graceful Shutdown

```typescript
server.on('stopping', () => {
  // Kubernetes will stop routing traffic
  healthcheckManager.update(ServingStatus.NOT_SERVING);
});
```

### Testing with an Isolated Manager

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHealthcheckManager, ServingStatus } from '@connectum/healthcheck';

describe('health check', () => {
  it('should track service status', () => {
    const manager = createHealthcheckManager();
    manager.initialize(['my.service.v1.MyService']);

    manager.update(ServingStatus.SERVING, 'my.service.v1.MyService');
    assert.ok(manager.areAllHealthy());

    manager.update(ServingStatus.NOT_SERVING, 'my.service.v1.MyService');
    assert.ok(!manager.areAllHealthy());
  });
});
```

## Dependencies

### Peer Dependencies

- `@connectum/core` -- Server factory and ProtocolRegistration types

### Dependencies

- `@bufbuild/protobuf` -- Protocol Buffers runtime
- `@connectrpc/connect` -- ConnectRPC core

## Requirements

- **Node.js**: >=22.13.0
- **pnpm**: >=11.0.0

## Documentation

- [Package Documentation](https://connectum-framework.github.io/docs/en/packages/healthcheck)
- [Health Checks Guide](https://connectum-framework.github.io/docs/en/guide/health-checks/protocol)
- [API Reference](https://connectum-framework.github.io/docs/en/api/)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

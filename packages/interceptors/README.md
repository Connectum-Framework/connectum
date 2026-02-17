# @connectum/interceptors

ConnectRPC interceptors for Connectum.

**@connectum/interceptors** is a collection of production-ready interceptors for ConnectRPC, providing error handling, resilience patterns (retry, circuit breaker, bulkhead, timeout, fallback), validation, and JSON serialization.

## Features

- **Error Handler** -- converts errors to ConnectError with correct gRPC codes
- **Timeout** -- limits request execution time
- **Bulkhead** -- limits the number of concurrent requests
- **Circuit Breaker** -- prevents cascading failures
- **Retry** -- retries with exponential backoff (cockatiel)
- **Fallback** -- graceful degradation on service failure (disabled by default)
- **Validation** -- input data validation via `@connectrpc/validate`
- **Serializer** -- automatic JSON serialization of protobuf messages
- **Logger** -- request and response logging
- **Method Filter** -- declarative per-method interceptor routing (ADR-014)

## Installation

```bash
pnpm add @connectum/interceptors
```

**Peer dependencies**:

```bash
pnpm add @connectrpc/connect @bufbuild/protobuf
```

## Default interceptor chain

The package provides a ready-made chain of 8 interceptors with a fixed order:

```
errorHandler -> timeout -> bulkhead -> circuitBreaker -> retry -> fallback -> validation -> serializer
```

| # | Interceptor | Default | Purpose |
|---|-------------|---------|---------|
| 1 | errorHandler | enabled | Catch-all error normalization (must be first) |
| 2 | timeout | enabled (30s) | Enforce deadline before processing starts |
| 3 | bulkhead | enabled (10/10) | Concurrency limiting |
| 4 | circuitBreaker | enabled (5 failures) | Cascading failure prevention |
| 5 | retry | enabled (3 attempts) | Retry transient failures with exponential backoff |
| 6 | fallback | **disabled** | Graceful degradation (requires a handler function) |
| 7 | validation | enabled | `@connectrpc/validate` (`createValidateInterceptor()`) |
| 8 | serializer | enabled | JSON serialization of protobuf responses |

**Why this order:**

1. **errorHandler** -- outer layer, catches all errors from the entire chain
2. **timeout** -- fail fast for slow requests before processing starts
3. **bulkhead** -- limit concurrent load to protect resources
4. **circuitBreaker** -- fast rejection during cascading failures
5. **retry** -- retry for transient failures
6. **fallback** -- last chance for graceful degradation
7. **validation** -- verify data correctness before business logic
8. **serializer** -- serialize response (innermost)

## Quick Start

### Integration with `@connectum/core` (recommended)

Use `createDefaultInterceptors()` with `createServer()`:

```typescript
import { createServer } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import routes from "#gen/routes.js";

const server = createServer({
  services: [routes],
  port: 5000,

  // Default chain with custom options
  interceptors: createDefaultInterceptors({
    timeout: { duration: 10000 },    // Custom timeout
    retry: false,                    // Disable retry
    // rest use defaults
  }),
});

await server.start();
```

To use a fully custom chain, pass individual interceptors directly:

```typescript
import {
  createErrorHandlerInterceptor,
  createTimeoutInterceptor,
} from "@connectum/interceptors";

const server = createServer({
  services: [routes],
  interceptors: [
    createErrorHandlerInterceptor({ logErrors: true }),
    createTimeoutInterceptor({ duration: 5000 }),
  ],
});
```

### Standalone usage (without createServer)

```typescript
import { createDefaultInterceptors } from "@connectum/interceptors";
import { createConnectTransport } from "@connectrpc/connect-node";

const interceptors = createDefaultInterceptors({
  timeout: { duration: 10000 },
  retry: { maxRetries: 5 },
  fallback: {
    handler: () => ({ data: [] }),
  },
});

const transport = createConnectTransport({
  baseUrl: "http://localhost:5000",
  interceptors,
});
```

### Using individual interceptors

```typescript
import {
  createErrorHandlerInterceptor,
  createRetryInterceptor,
  createTimeoutInterceptor,
} from "@connectum/interceptors";

const interceptors = [
  createErrorHandlerInterceptor({ logErrors: true }),
  createTimeoutInterceptor({ duration: 5000 }),
  createRetryInterceptor({ maxRetries: 2 }),
];
```

## Exported Factories

Each interceptor is available as a named export:

| Factory | Import Subpath |
|---------|----------------|
| `createErrorHandlerInterceptor` | `@connectum/interceptors/errorHandler` |
| `createLoggerInterceptor` | `@connectum/interceptors/logger` |
| `createSerializerInterceptor` | `@connectum/interceptors/serializer` |
| `createRetryInterceptor` | `@connectum/interceptors/retry` |
| `createCircuitBreakerInterceptor` | `@connectum/interceptors/circuit-breaker` |
| `createTimeoutInterceptor` | `@connectum/interceptors/timeout` |
| `createBulkheadInterceptor` | `@connectum/interceptors/bulkhead` |
| `createFallbackInterceptor` | `@connectum/interceptors/fallback` |
| `createDefaultInterceptors` | `@connectum/interceptors/defaults` |
| `createMethodFilterInterceptor` | `@connectum/interceptors/method-filter` |

All factories are also available via the main export `@connectum/interceptors`.

## Interceptor Reference

### Error Handler

Converts arbitrary errors to `ConnectError` with correct gRPC codes. Recognizes the `SanitizableError` protocol from `@connectum/core`: errors that are an `instanceof Error` and carry a `clientMessage` string, a `serverDetails` object, and a numeric `code` are automatically sanitized -- the client receives only `clientMessage`, while `serverDetails` are preserved for server-side logging.

**Important**: must be first in the chain to catch errors from all subsequent interceptors.

```typescript
import { createErrorHandlerInterceptor } from "@connectum/interceptors";

const interceptor = createErrorHandlerInterceptor({
  includeStackTrace: false,  // Include stack trace (default: NODE_ENV !== "production")
  onError: ({ error, code, serverDetails, stack }) => {
    logger.error('RPC error', { message: error.message, code, serverDetails, stack });
  },
});
```

### Timeout

Prevents request hanging by setting a maximum execution time.

```typescript
import { createTimeoutInterceptor } from "@connectum/interceptors";

const interceptor = createTimeoutInterceptor({
  duration: 30000,      // Timeout in ms (default: 30000)
  skipStreaming: true,   // Skip streaming calls (default: true)
});
```

**Response on timeout:**
```json
{
  "code": "deadline_exceeded",
  "message": "Request timeout after 30000ms"
}
```

### Bulkhead

Limits the number of concurrent requests to prevent resource exhaustion.

```typescript
import { createBulkheadInterceptor } from "@connectum/interceptors";

const interceptor = createBulkheadInterceptor({
  capacity: 10,        // Max concurrent requests (default: 10)
  queueSize: 10,       // Wait queue size (default: 10)
  skipStreaming: true,  // Skip streaming calls (default: true)
});
```

**Response on capacity exceeded:**
```json
{
  "code": "resource_exhausted",
  "message": "Bulkhead capacity exceeded (active: 10/10, queued: 10/10)"
}
```

### Circuit Breaker

Prevents cascading failures by breaking the circuit on repeated errors.

```typescript
import { createCircuitBreakerInterceptor } from "@connectum/interceptors";

const interceptor = createCircuitBreakerInterceptor({
  threshold: 5,           // Open after N consecutive failures (default: 5)
  halfOpenAfter: 30000,   // Transition to half-open after N ms (default: 30000)
  skipStreaming: true,     // Skip streaming calls (default: true)
});
```

**Circuit states:**

| State | Description |
|-------|-------------|
| **Closed** | Normal operation, requests pass through |
| **Open** | Failure: requests are rejected immediately |
| **Half-Open** | Testing: one request is allowed to check recovery |

**Response on open circuit:**
```json
{
  "code": "unavailable",
  "message": "Circuit breaker is open (5 consecutive failures)"
}
```

### Retry

Retries failed unary calls with exponential backoff. Built on [cockatiel](https://github.com/connor4312/cockatiel).

```typescript
import { createRetryInterceptor } from "@connectum/interceptors";

const interceptor = createRetryInterceptor({
  maxRetries: 3,          // Number of retry attempts (default: 3)
  initialDelay: 200,      // Initial delay in ms (default: 200)
  maxDelay: 5000,         // Maximum delay in ms (default: 5000)
  skipStreaming: true,     // Skip streaming calls (default: true)
  retryableCodes: [       // gRPC codes to retry (default: Unavailable, ResourceExhausted)
    Code.Unavailable,
    Code.ResourceExhausted,
  ],
});
```

**Backoff strategy:**
- Attempt 1: delay `initialDelay` (200 ms)
- Attempt 2: delay `initialDelay * 2` (400 ms)
- Attempt 3: delay `initialDelay * 4` (800 ms)
- ... and so on, but no more than `maxDelay`

### Fallback

Provides graceful degradation on service failure. **Disabled by default** -- requires a `handler` function to work.

```typescript
import { createFallbackInterceptor } from "@connectum/interceptors";

const interceptor = createFallbackInterceptor({
  handler: (error) => {
    console.error("Service failed, returning cached data:", error);
    return { message: getCachedData() };
  },
  skipStreaming: true,   // Skip streaming calls (default: true)
});
```

Enabling fallback in the default chain:

```typescript
const interceptors = createDefaultInterceptors({
  fallback: {
    handler: () => ({ data: [] }),
  },
});
```

### Validation

Input data validation using the official `@connectrpc/validate` package (`createValidateInterceptor()`). Checks proto constraints before passing the request to business logic.

In the default chain, `createValidateInterceptor()` from `@connectrpc/validate` is used directly. The `validation` option in `createDefaultInterceptors()` accepts only `boolean`:

```typescript
const interceptors = createDefaultInterceptors({
  validation: true,  // Enabled by default
  // validation: false, // Disable
});
```

**Example proto file with validation constraints:**

```protobuf
syntax = "proto3";

import "buf/validate/validate.proto";

message CreateUserRequest {
  string email = 1 [(buf.validate.field).string.email = true];
  string name = 2 [(buf.validate.field).string.min_len = 1];
  int32 age = 3 [(buf.validate.field).int32.gte = 0];
}
```

### Serializer

Automatic JSON serialization of protobuf messages via `@bufbuild/protobuf`.

```typescript
import { createSerializerInterceptor } from "@connectum/interceptors";

const interceptor = createSerializerInterceptor({
  skipGrpcServices: true,    // Skip for gRPC (binary protobuf) (default: true)
  alwaysEmitImplicit: true,  // Include default values in JSON (default: true)
  ignoreUnknownFields: true, // Ignore unknown fields (default: true)
});
```

### Logger

Request and response logging.

```typescript
import { createLoggerInterceptor } from "@connectum/interceptors";

const interceptor = createLoggerInterceptor({
  level: "info",            // Log level (default: "debug")
  skipHealthCheck: true,    // Skip health check (default: true)
  logger: console.info,    // Custom logger (default: console[level])
});
```

## Per-Service and Per-Method Interceptors

Connectum provides three approaches for applying interceptors to specific services or methods.

### Approach 1: ConnectRPC native per-service/per-method (recommended)

ConnectRPC natively supports per-service and per-method interceptors via `router.service()` and `router.rpc()` options:

```typescript
import type { ConnectRouter } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter_pb.js";

export default (router: ConnectRouter) => {
  // Per-service interceptors -- applied to all methods of the service
  router.service(GreeterService, impl, {
    interceptors: [requireAuth, auditLog],
  });

  // Per-method interceptors -- applied only to a specific method
  router.rpc(GreeterService, GreeterService.methods.sayHello, helloImpl, {
    interceptors: [rateLimiter],
  });
};
```

Use this approach when interceptors are tied to a specific service or method at the routing level.

### Approach 2: createMethodFilterInterceptor (declarative routing)

`createMethodFilterInterceptor` is a convenience helper for declarative per-method interceptor routing based on wildcard patterns. Implements [ADR-014](https://connectum.dev/en/contributing/adr/014-method-filter-interceptor).

```typescript
import {
  createMethodFilterInterceptor,
  createTimeoutInterceptor,
  createCircuitBreakerInterceptor,
} from "@connectum/interceptors";

const perMethodInterceptor = createMethodFilterInterceptor({
  // Global wildcard: all methods
  "*": [logRequest],

  // Service wildcard: all methods of a service
  "admin.v1.AdminService/*": [requireAdmin],

  // Exact match: specific method
  "user.v1.UserService/DeleteUser": [requireAdmin, auditLog],
});

const server = createServer({
  services: [routes],
  interceptors: [perMethodInterceptor],
});
```

**Supported patterns:**

| Pattern | Description | Example |
|---------|-------------|---------|
| `"*"` | All methods of all services | `"*": [logRequest]` |
| `"Service/*"` | All methods of a specific service | `"admin.v1.AdminService/*": [auth]` |
| `"Service/Method"` | Specific method | `"user.v1.UserService/GetUser": [cache]` |

**Execution order:**

All matching patterns are executed sequentially (from general to specific):

```
Request: user.v1.UserService/GetUser

1. "*": [logRequest]                       -- global (always)
2. "user.v1.UserService/*": [auth]         -- service-level (if defined)
3. "user.v1.UserService/GetUser": [cache]  -- exact match (if defined)

Resulting chain: logRequest -> auth -> cache -> next(req)
```

**Example: different resilience settings for different methods:**

```typescript
createMethodFilterInterceptor({
  // Fast operations -- timeout 5s
  "catalog.v1.CatalogService/GetProduct": [
    createTimeoutInterceptor({ duration: 5_000 }),
  ],
  // Heavy operations -- timeout 30s + circuit breaker
  "report.v1.ReportService/*": [
    createTimeoutInterceptor({ duration: 30_000 }),
    createCircuitBreakerInterceptor({ threshold: 3 }),
  ],
});
```

### Approach 3: Custom interceptor with manual filtering

For complex or dynamic filtering conditions, you can write a custom interceptor:

```typescript
import type { Interceptor } from "@connectrpc/connect";

const conditionalAuth: Interceptor = (next) => async (req) => {
  // Dynamic filtering logic
  if (req.service.typeName === "admin.v1.AdminService") {
    await verifyAdminToken(req);
  }
  return next(req);
};
```

Use this approach for cases not covered by `createMethodFilterInterceptor` patterns (e.g., filtering by request content, dynamic conditions).

### When to Use Which Approach

| Scenario | Approach |
|----------|----------|
| Interceptor tied to a specific service/method in the router | ConnectRPC native (`router.service()` / `router.rpc()`) |
| Declarative routing by patterns for a group of services | `createMethodFilterInterceptor` |
| Dynamic filtering logic (by request content, runtime conditions) | Custom interceptor |
| Technical interceptor limitation (streaming, gRPC binary) | `skip*` options of the interceptor |

### About skip* Options

The `skipStreaming`, `skipGrpcServices`, and `skipHealthCheck` options in individual interceptors are **not** routing concerns. They are technical limitations of the interceptors themselves:

- **`skipStreaming`** (retry, timeout, bulkhead, circuit-breaker, fallback): Resilience interceptors wrap the entire call. For streaming this is technically incorrect -- you cannot retry a stream, limit timeout for a long-lived connection, or replace a stream with a fallback value.
- **`skipGrpcServices`** (serializer): JSON serialization for gRPC binary protocol is technically impossible. This is a protocol error guard.
- **`skipHealthCheck`** (logger): Convenience shortcut for excluding health check from logs.

These options complement rather than replace `createMethodFilterInterceptor`. Method filter manages business routing ("which interceptors for which methods"), while skip* handles technical limitations ("interceptor cannot work with this type of call").

## Types

### MethodFilterMap

```typescript
type MethodFilterMap = Record<string, Interceptor[]>;
```

### DefaultInterceptorOptions

```typescript
interface DefaultInterceptorOptions {
  errorHandler?: boolean | ErrorHandlerOptions;
  timeout?: boolean | TimeoutOptions;
  bulkhead?: boolean | BulkheadOptions;
  circuitBreaker?: boolean | CircuitBreakerOptions;
  retry?: boolean | RetryOptions;
  fallback?: boolean | FallbackOptions;
  validation?: boolean;
  serializer?: boolean | SerializerOptions;
}
```

### ErrorHandlerOptions

```typescript
interface ErrorHandlerOptions {
  logErrors?: boolean;          // default: NODE_ENV !== "production" (deprecated, use onError)
  includeStackTrace?: boolean;  // default: NODE_ENV !== "production"
  onError?: (info: {
    error: Error;
    code: number;
    serverDetails?: Readonly<Record<string, unknown>>;
    stack?: string;
  }) => void;
}
```

When `onError` is provided, it replaces the default `console.error` logging. For `SanitizableError` instances, the callback receives `serverDetails` with the diagnostic data.

### TimeoutOptions

```typescript
interface TimeoutOptions {
  duration?: number;        // default: 30000 (30 seconds)
  skipStreaming?: boolean;  // default: true
}
```

### BulkheadOptions

```typescript
interface BulkheadOptions {
  capacity?: number;        // default: 10
  queueSize?: number;       // default: 10
  skipStreaming?: boolean;  // default: true
}
```

### CircuitBreakerOptions

```typescript
interface CircuitBreakerOptions {
  threshold?: number;       // default: 5
  halfOpenAfter?: number;   // default: 30000
  skipStreaming?: boolean;  // default: true
}
```

### RetryOptions

```typescript
interface RetryOptions {
  maxRetries?: number;       // default: 3
  initialDelay?: number;     // default: 200
  maxDelay?: number;         // default: 5000
  skipStreaming?: boolean;   // default: true
  retryableCodes?: Code[];   // default: [Code.Unavailable, Code.ResourceExhausted]
}
```

### FallbackOptions

```typescript
interface FallbackOptions<T = unknown> {
  handler: (error: Error) => T | Promise<T>;  // Required
  skipStreaming?: boolean;                     // default: true
}
```

### LoggerOptions

```typescript
interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error";  // default: "debug"
  skipHealthCheck?: boolean;                     // default: true
  logger?: (message: string, ...args: unknown[]) => void;
}
```

### SerializerOptions

```typescript
interface SerializerOptions {
  skipGrpcServices?: boolean;    // default: true
  alwaysEmitImplicit?: boolean;  // default: true
  ignoreUnknownFields?: boolean; // default: true
}
```

## Examples

### Production configuration with createServer

```typescript
import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import { createDefaultInterceptors } from "@connectum/interceptors";
import routes from "#gen/routes.js";

const server = createServer({
  services: [routes],
  port: 5000,
  protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
  shutdown: { autoShutdown: true },

  interceptors: createDefaultInterceptors({
    errorHandler: {
      includeStackTrace: process.env.NODE_ENV !== "production",
      onError: ({ error, code, serverDetails }) => {
        console.error('RPC error', { message: error.message, code, serverDetails });
      },
    },
    timeout: { duration: 10000 },
    bulkhead: { capacity: 20, queueSize: 20 },
    circuitBreaker: { threshold: 3 },
    retry: {
      maxRetries: 2,
      initialDelay: 100,
    },
    // fallback disabled by default
    // validation enabled by default
    // serializer enabled by default
  }),
});

server.on("ready", () => {
  healthcheckManager.update(ServingStatus.SERVING);
});

await server.start();
```

### Enabling fallback with handler

```typescript
const interceptors = createDefaultInterceptors({
  fallback: {
    handler: (error) => {
      console.error("Service failed:", error);
      return { items: [], total: 0 };
    },
  },
});
```

### Client-side interceptors

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createRetryInterceptor,
  createTimeoutInterceptor,
} from "@connectum/interceptors";

const transport = createConnectTransport({
  baseUrl: "https://api.example.com",
  interceptors: [
    createTimeoutInterceptor({ duration: 5000 }),
    createRetryInterceptor({
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 10000,
      retryableCodes: [Code.Unavailable, Code.ResourceExhausted],
    }),
  ],
});

const client = createClient(MyService, transport);
```

### Fully custom chain

```typescript
import {
  createErrorHandlerInterceptor,
  createTimeoutInterceptor,
  createRetryInterceptor,
  createSerializerInterceptor,
} from "@connectum/interceptors";

const server = createServer({
  services: [routes],
  interceptors: [
    createErrorHandlerInterceptor({ logErrors: true }),
    createTimeoutInterceptor({ duration: 5000 }),
    createRetryInterceptor({ maxRetries: 2 }),
    createSerializerInterceptor(),
  ],
});
```

## Migration

### Removed Interceptors

The following interceptors have been removed from the package and moved to examples:

| Interceptor | Moved To | Reason |
|-------------|----------|--------|
| `redact` | `examples/extensions/redact/` | Domain-specific, not part of a universal framework |
| `addToken` | `examples/interceptors/jwt/` | Domain-specific, not part of a universal framework |
| `validation` (custom) | -- | Replaced by `@connectrpc/validate` (`createValidateInterceptor()`) |

**For `addToken`:** use the example from `examples/interceptors/jwt/` or write your own interceptor.

**For `redact`:** use the example from `examples/extensions/redact/` or implement as a custom interceptor.

**For `validation`:** replace with `@connectrpc/validate`:

```typescript
// Before (custom validation)
import { createValidationInterceptor } from "@connectum/interceptors";
const interceptor = createValidationInterceptor({ skipStreaming: true });

// After (official @connectrpc/validate)
import { createValidateInterceptor } from "@connectrpc/validate";
const interceptor = createValidateInterceptor();
// Or enabled automatically via createDefaultInterceptors()
```

### Changes in retry interceptor

| Parameter | Before | After |
|-----------|--------|-------|
| `maxRetries` | default: 5 | default: 3 |
| `initialDelay` | `timeout: 100` | `initialDelay: 200` |
| `maxDelay` | -- | 5000 ms |
| `retryableCodes` | -- | `[Code.Unavailable, Code.ResourceExhausted]` |
| Implementation | Built-in | [cockatiel](https://github.com/connor4312/cockatiel) |

### Changes in default chain

Resilience interceptors (timeout, bulkhead, circuitBreaker, retry, fallback) are now **included** in the default chain (previously optional). Fallback remains disabled by default.

## Dependencies

### Internal

- `@connectrpc/connect` -- ConnectRPC core
- `@connectrpc/validate` -- Official validation interceptor
- `@bufbuild/protobuf` -- Protocol Buffers runtime
- `cockatiel` -- Resilience patterns (retry, circuit breaker, bulkhead, timeout)

### Dev

- `@biomejs/biome` -- Linting and formatting
- `typescript` -- Type checking

## Requirements

- **Node.js**: >=25.2.0 (for stable type stripping)
- **TypeScript**: >=5.7.2 (for type checking)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

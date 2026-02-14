# @connectum/otel

OpenTelemetry instrumentation for Connectum.

**@connectum/otel** is a comprehensive observability solution using OpenTelemetry. Provides distributed tracing, metrics collection, and structured logging out of the box.

## Features

- **Server Interceptor**: `createOtelInterceptor()` -- server-side tracing + metrics for ConnectRPC
- **Client Interceptor**: `createOtelClientInterceptor()` -- client-side tracing + metrics with context propagation
- **Deep Tracing**: `traced()` and `traceAll()` -- business logic instrumentation
- **Logging**: `getLogger(name, options?)` -- structured logging with convenience methods and raw OTel access
- **Standalone API**: `getTracer()`, `getMeter()` -- lazy singletons
- **OTel Semantic Conventions**: Attributes following OpenTelemetry RPC standards
- **OTLP Exporters**: Built-in OTLP HTTP/gRPC exporter support
- **Console Exporters**: Debug exporters for development
- **Environment Configuration**: Configuration via environment variables
- **Provider Management**: `initProvider()` / `shutdownProvider()`

## Installation

```bash
pnpm add @connectum/otel
```

**Peer dependencies** (installed automatically):

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node
```

## Quick Start

### Basic usage

```typescript
import { getTracer, getMeter, getLogger } from "@connectum/otel";

// Tracing
const tracer = getTracer();
const span = tracer.startSpan("my-operation");
try {
  // Your code here
  span.setAttribute("user.id", "123");
  span.setStatus({ code: SpanStatusCode.OK });
} finally {
  span.end();
}

// Metrics
const meter = getMeter();
const counter = meter.createCounter("requests.total");
counter.add(1, { method: "GET", status: 200 });

const histogram = meter.createHistogram("request.duration");
histogram.record(125.5, { method: "GET" });

// Logging
const logger = getLogger("MyService");
logger.info("User logged in", { userId: "123", ip: "192.168.1.1" });
logger.warn("Rate limit approaching", { current: 95, max: 100 });
logger.error("Request failed", { error: "timeout" });
logger.debug("Processing details", { step: 3 });
```

### With context propagation

```typescript
import { getTracer } from "@connectum/otel";
import { context, trace } from "@opentelemetry/api";

const tracer = getTracer();

// Start root span
tracer.startActiveSpan("handleRequest", async (span) => {
  try {
    span.setAttribute("http.method", "GET");

    // Nested span (automatically inherits context)
    await tracer.startActiveSpan("fetchData", async (childSpan) => {
      const data = await fetchData();
      childSpan.setAttribute("data.count", data.length);
      childSpan.end();
      return data;
    });

    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
});
```

### RPC Interceptor (createOtelInterceptor)

```typescript
import { createServer } from "@connectum/core";
import { createOtelInterceptor } from "@connectum/otel";
import routes from "#gen/routes.js";

const server = createServer({
  services: [routes],
  port: 5000,
  interceptors: [
    createOtelInterceptor({
      filter: ({ service }) => !service.includes("grpc.health"),
    }),
  ],
});

await server.start();
```

### Client Interceptor (createOtelClientInterceptor)

```typescript
import { createConnectTransport } from "@connectrpc/connect-node";
import { createOtelClientInterceptor } from "@connectum/otel";

const transport = createConnectTransport({
  baseUrl: "http://api.example.com:5000",
  interceptors: [
    createOtelClientInterceptor({
      serverAddress: "api.example.com",
      serverPort: 5000,
      filter: ({ service }) => !service.includes("grpc.health"),
    }),
  ],
});
```

### Deep Tracing: traced()

Wrap a single function in an OTel span:

```typescript
import { traced } from "@connectum/otel";

// Wrap an async function
const findUser = traced(async (id: string) => {
  return await db.users.findById(id);
}, { name: "UserService.findUser" });

// Each call creates a span
await findUser("123");
// Creates span: "UserService.findUser"
```

### Deep Tracing: traceAll()

Wrap all methods of an object via Proxy:

```typescript
import { traceAll } from "@connectum/otel";

class UserService {
  async getUser(id: string) {
    return await db.users.findById(id);
  }

  async createUser(data: UserData) {
    return await db.users.create(data);
  }
}

// Auto-instrument all methods (does NOT mutate the original)
const service = traceAll(new UserService(), {
  prefix: "UserService",
  exclude: ["internalHelper"],
});

// All method calls now automatically create spans
await service.getUser("123");
// Creates span: "UserService.getUser"
```

### Environment configuration

```bash
# .env file

# Service metadata
OTEL_SERVICE_NAME=my-service
OTEL_SERVICE_VERSION=1.0.0
OTEL_SERVICE_NAMESPACE=production

# Trace exporter
OTEL_TRACES_EXPORTER=otlp  # "otlp", "console", or "none"
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces

# Metrics exporter
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics

# Logs exporter
OTEL_LOGS_EXPORTER=console

# OTLP settings
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf  # "http/protobuf" or "grpc"
OTEL_EXPORTER_OTLP_HEADERS=x-api-key=secret

# Batch span processor
OTEL_BSP_SCHEDULE_DELAY=5000
OTEL_BSP_MAX_QUEUE_SIZE=2048
OTEL_BSP_MAX_EXPORT_BATCH_SIZE=512

# Ignored instrumentations (comma-separated)
OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns
```

## Main Exports

### createOtelInterceptor() (Server)

ConnectRPC interceptor for tracing + metrics:

```typescript
import { createOtelInterceptor } from "@connectum/otel";

const interceptor = createOtelInterceptor({
  withoutTracing?: boolean;       // Disable tracing (metrics only)
  withoutMetrics?: boolean;       // Disable metrics (tracing only)
  trustRemote?: boolean;          // Use extracted remote context as parent span (default: false)
  filter?: OtelFilter;            // Skip specific requests
  attributeFilter?: OtelAttributeFilter; // Exclude specific attributes
  serverAddress?: string;         // Override server.address (default: os.hostname())
  serverPort?: number;            // Opt-in server.port attribute
  recordMessages?: boolean;       // Include request/response in span events (default: false)
});
```

### createOtelClientInterceptor() (Client)

ConnectRPC interceptor for outgoing calls -- tracing + metrics:

```typescript
import { createOtelClientInterceptor } from "@connectum/otel";

const interceptor = createOtelClientInterceptor({
  serverAddress: string;              // REQUIRED -- target server address
  serverPort?: number;                // Target server port
  withoutTracing?: boolean;           // Disable tracing (metrics only)
  withoutMetrics?: boolean;           // Disable metrics (tracing only)
  filter?: OtelFilter;               // Skip specific requests
  attributeFilter?: OtelAttributeFilter; // Exclude specific attributes
  recordMessages?: boolean;           // Include request/response in span events (default: false)
});
```

Key differences from server interceptor:
- Uses `propagation.inject()` to propagate trace context to outgoing requests
- Uses `SpanKind.CLIENT` instead of `SpanKind.SERVER`
- Records `rpc.client.*` metrics instead of `rpc.server.*`
- `serverAddress` is **required** (target server, not local hostname)
- No `trustRemote` option (client always creates spans in active context)

### Shared Utilities

Reusable helpers for advanced use cases:

```typescript
import { estimateMessageSize, buildErrorAttributes } from "@connectum/otel";

// Estimate protobuf message size in bytes
const size = estimateMessageSize(protoMessage);

// Build OTel error attributes from ConnectError/Error
const attrs = buildErrorAttributes(error);
```

### getTracer()

Lazy singleton OpenTelemetry tracer:

```typescript
import { getTracer } from "@connectum/otel";
import type { Tracer } from "@opentelemetry/api";

const tracer = getTracer();

// Start span
const span = tracer.startSpan("operation-name", {
  attributes: {
    "user.id": "123",
    "http.method": "GET",
  },
});

// Start active span (with context propagation)
await tracer.startActiveSpan("operation", async (span) => {
  // Your code here
  span.end();
});
```

### getMeter()

Lazy singleton OpenTelemetry meter:

```typescript
import { getMeter } from "@connectum/otel";
import type { Meter } from "@opentelemetry/api";

const meter = getMeter();

// Counter
const counter = meter.createCounter("metric.name", {
  description: "Number of requests",
  unit: "1",
});
counter.add(1, { method: "GET" });

// UpDown Counter
const activeConnections = meter.createUpDownCounter("active.connections");
activeConnections.add(1);  // Connection opened
activeConnections.add(-1); // Connection closed

// Histogram
const histogram = meter.createHistogram("request.duration", {
  description: "Request duration",
  unit: "ms",
});
histogram.record(125.5, { method: "GET", status: 200 });

// Observable Gauge
meter.createObservableGauge("memory.usage", {
  description: "Memory usage",
  unit: "bytes",
}).addCallback((observableResult) => {
  const usage = process.memoryUsage();
  observableResult.observe(usage.heapUsed, { type: "heap" });
});
```

### getLogger()

Structured logger with console-like convenience methods and raw OTel LogRecord access.
Automatically includes `logger.name` attribute and optional `defaultAttributes` in every log entry.
Trace correlation (trace_id/span_id) is handled automatically by the OpenTelemetry SDK when an active span exists.

```typescript
import { getLogger } from "@connectum/otel";
import type { Logger, LoggerOptions } from "@connectum/otel";

const logger = getLogger("OrderService");

// Console-like API
logger.info("Processing order", { orderId: "123" });
logger.warn("Low stock", { sku: "ABC", remaining: 2 });
logger.error("Payment failed", { error: "timeout", orderId: "123" });
logger.debug("Validation details", { fields: ["email", "phone"] });

// Default attributes (included in every log entry)
const logger2 = getLogger("PaymentService", {
  defaultAttributes: { "service.layer": "domain", env: "production" },
});
logger2.info("Charge created"); // attributes: { "logger.name": "PaymentService", "service.layer": "domain", env: "production" }

// Raw OTel LogRecord access (bypasses convenience wrappers)
import { SeverityNumber } from "@opentelemetry/api-logs";

logger.emit({
  severityNumber: SeverityNumber.INFO,
  severityText: "INFO",
  body: "Custom record",
  attributes: { custom: true },
  timestamp: Date.now(),
});
```

### traced()

Type-safe function wrapper for OpenTelemetry tracing:

```typescript
import { traced } from "@connectum/otel";

const fn = traced(originalFn, {
  name?: string;                        // Span name (default: fn.name)
  recordArgs?: boolean | string[];      // Record args as span attributes (default: false)
  argsFilter?: (args: unknown[]) => unknown[];  // Transform/mask args
  attributes?: Record<string, string | number | boolean>;  // Custom span attributes
});
```

### traceAll()

Proxy-based object wrapper for OpenTelemetry tracing:

```typescript
import { traceAll } from "@connectum/otel";

const instrumented = traceAll(object, {
  prefix?: string;                      // Span name prefix (default: constructor.name)
  include?: string[];                   // Whitelist of methods to wrap
  exclude?: string[];                   // Blacklist of methods to skip
  recordArgs?: boolean | string[];      // Record args as span attributes (default: false)
  argsFilter?: (methodName: string, args: unknown[]) => unknown[];  // Per-method args filter
});
```

**Key differences from `traced()`:**
- Wraps all methods of an object at once (via ES6 Proxy)
- Does NOT mutate the original object or its prototype
- Method wrappers are created lazily (on first access)
- Prevents double-wrapping automatically

### Configuration

Environment-based configuration helpers:

```typescript
import {
  getServiceMetadata,
  getOTLPSettings,
  getCollectorOptions,
  getBatchSpanProcessorOptions,
  getIgnoredInstrumentations,
  ExporterType,
} from "@connectum/otel";

// Service metadata
const metadata = getServiceMetadata();
// { name: "my-service", version: "1.0.0", namespace: "production" }

// OTLP settings
const otlpSettings = getOTLPSettings();
// { protocol: "http/protobuf", headers: { ... } }

// Collector options
const collectorOptions = getCollectorOptions();
// { traces: { exporter: "otlp", endpoint: "..." }, metrics: { ... } }

// Batch span processor options
const bspOptions = getBatchSpanProcessorOptions();
// { scheduledDelayMillis: 5000, maxQueueSize: 2048, ... }

// Ignored instrumentations
const ignored = getIgnoredInstrumentations();
// ["fs", "dns"]
```

### Provider Management

```typescript
import { initProvider, getProvider, shutdownProvider } from "@connectum/otel";
import type { ProviderOptions } from "@connectum/otel";

// Explicit initialization (optional -- getTracer/getMeter/getLogger auto-init)
initProvider({
  serviceName: "my-service",
  serviceVersion: "1.0.0",
});

// Access current provider
const provider = getProvider();

// Graceful shutdown
await shutdownProvider();
```

## Types

### ExporterType

```typescript
const ExporterType = {
  OTLP: "otlp",
  CONSOLE: "console",
  NONE: "none",
} as const;

type ExporterType = typeof ExporterType[keyof typeof ExporterType];
```

### OTLPSettings

```typescript
type OTLPSettings = {
  protocol: "http/protobuf" | "grpc";
  headers: Record<string, string>;
};
```

### CollectorOptions

```typescript
type CollectorOptions = {
  traces: {
    exporter: ExporterType;
    endpoint?: string;
  };
  metrics: {
    exporter: ExporterType;
    endpoint?: string;
  };
  logs: {
    exporter: ExporterType;
    endpoint?: string;
  };
};
```

### BatchSpanProcessorOptions

```typescript
type BatchSpanProcessorOptions = {
  scheduledDelayMillis: number;
  maxQueueSize: number;
  maxExportBatchSize: number;
  exportTimeoutMillis: number;
};
```

## Environment Variables

### Service Metadata

- `OTEL_SERVICE_NAME` - Service name (required)
- `OTEL_SERVICE_VERSION` - Service version (optional)
- `OTEL_SERVICE_NAMESPACE` - Service namespace (optional, e.g., "production")

### Exporters

- `OTEL_TRACES_EXPORTER` - Trace exporter type (`otlp`, `console`, `none`)
- `OTEL_METRICS_EXPORTER` - Metrics exporter type
- `OTEL_LOGS_EXPORTER` - Logs exporter type

### OTLP Endpoints

- `OTEL_EXPORTER_OTLP_ENDPOINT` - Base OTLP endpoint
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` - Traces endpoint (overrides base)
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` - Metrics endpoint (overrides base)
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` - Logs endpoint (overrides base)

### OTLP Settings

- `OTEL_EXPORTER_OTLP_PROTOCOL` - Protocol (`http/protobuf`, `grpc`)
- `OTEL_EXPORTER_OTLP_HEADERS` - Headers (comma-separated key=value pairs)

### Batch Span Processor

- `OTEL_BSP_SCHEDULE_DELAY` - Schedule delay (ms, default: 5000)
- `OTEL_BSP_MAX_QUEUE_SIZE` - Max queue size (default: 2048)
- `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` - Max batch size (default: 512)
- `OTEL_BSP_EXPORT_TIMEOUT` - Export timeout (ms, default: 30000)

### Instrumentations

- `OTEL_NODE_DISABLED_INSTRUMENTATIONS` - Comma-separated list of disabled instrumentations

## Examples

### Full setup with createServer

```typescript
import { createServer, ServingStatus } from "@connectum/core";
import { createOtelInterceptor, getLogger } from "@connectum/otel";
import routes from "#gen/routes.js";

const logger = getLogger("MyService");

const server = createServer({
  services: [routes],
  port: 5000,
  interceptors: [
    createOtelInterceptor({
      filter: ({ service }) => !service.includes("grpc.health"),
    }),
  ],
});

server.on("ready", () => {
  logger.info("Server started", {
    port: server.address?.port,
    host: server.address?.address,
  });
  server.health.update(ServingStatus.SERVING);
});

await server.start();
```

### Custom metrics dashboard

```typescript
import { getMeter } from "@connectum/otel";

const meter = getMeter();

class MetricsDashboard {
  private requestCounter = meter.createCounter("http.requests.total");
  private requestDuration = meter.createHistogram("http.request.duration");
  private activeRequests = meter.createUpDownCounter("http.requests.active");

  async handleRequest(req: Request) {
    const start = Date.now();
    this.activeRequests.add(1);

    try {
      const result = await processRequest(req);

      this.requestCounter.add(1, {
        method: req.method,
        status: 200,
      });

      return result;
    } catch (error) {
      this.requestCounter.add(1, {
        method: req.method,
        status: 500,
      });
      throw error;
    } finally {
      const duration = Date.now() - start;
      this.requestDuration.record(duration, {
        method: req.method,
      });
      this.activeRequests.add(-1);
    }
  }
}
```

### Distributed tracing with ConnectRPC

```typescript
import { createServer } from "@connectum/core";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createClient } from "@connectrpc/connect";
import { createOtelInterceptor, createOtelClientInterceptor } from "@connectum/otel";
import routes from "#gen/routes.js";
import { UserService } from "#gen/user_pb.js";

// Service A: gRPC server with server interceptor
const server = createServer({
  services: [routes],
  port: 5000,
  interceptors: [
    createOtelInterceptor({
      serverPort: 5000,
      filter: ({ service }) => !service.includes("grpc.health"),
    }),
  ],
});

// Service A: Client to call Service B with context propagation
const transport = createConnectTransport({
  baseUrl: "http://service-b:5001",
  interceptors: [
    createOtelClientInterceptor({
      serverAddress: "service-b",
      serverPort: 5001,
    }),
  ],
});

const userClient = createClient(UserService, transport);

// Trace context is automatically propagated:
// Server span (incoming) -> Client span (outgoing) -> Service B server span
const user = await userClient.getUser({ id: "123" });
```

### Auto-instrument repository

```typescript
import { traceAll } from "@connectum/otel";

class UserRepository {
  async findById(id: string) {
    return await db.users.findById(id);
  }

  async findByEmail(email: string) {
    return await db.users.findByEmail(email);
  }

  async create(data: UserData) {
    return await db.users.create(data);
  }
}

// Auto-instrument all methods (does NOT mutate original)
const repository = traceAll(new UserRepository(), {
  prefix: "UserRepository",
  recordArgs: true,  // Include method args in spans
});

// All calls automatically traced
await repository.findById("123");
// Creates span: "UserRepository.findById" with attributes:
// - function.args: '["123"]'
```

## Documentation

- [Quick Start](https://connectum.dev/en/guide/quickstart) - Setup observability
- [Architecture Overview](https://connectum.dev/en/guide/advanced/architecture) - Overall architecture
- [Observability Guide](https://connectum.dev/en/guide/observability) - Best practices

## Dependencies

### Internal Dependencies

- `@connectrpc/connect` - ConnectRPC (for ConnectError type)

### External Dependencies

- `@opentelemetry/api` - OpenTelemetry API
- `@opentelemetry/sdk-node` - OpenTelemetry SDK
- `@opentelemetry/auto-instrumentations-node` - Auto-instrumentations
- `@opentelemetry/exporter-trace-otlp-http` - OTLP HTTP exporter
- `@opentelemetry/exporter-metrics-otlp-http` - OTLP metrics exporter
- `env-var` - Environment variables

## Requirements

- **Node.js**: >=25.2.0 (for stable type stripping)
- **TypeScript**: >=5.7.2 (for type checking)

## License

MIT

---

**Part of [@connectum](../../README.md)** - Universal framework for production-ready gRPC/ConnectRPC microservices

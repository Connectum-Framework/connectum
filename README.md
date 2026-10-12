<p align="center">
<a href="https://connectum.dev">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://connectum.dev/assets/splash-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://connectum.dev/assets/splash.png">
  <img alt="Connectum — Microservices Framework" src="https://connectum.dev/assets/splash.png" width="600">
</picture>
</a>
</p>

<p align="center">
  <strong>gRPC/ConnectRPC framework for Node.js microservices</strong>
</p>

<p align="center">
  <a href="https://connectum.dev/en/guide/runtime-compatibility"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-brightgreen" alt="Node.js runtime compatibility"></a>
  <a href="https://nodejs.org/api/typescript.html"><img src="https://img.shields.io/badge/TypeScript-Native-blue" alt="TypeScript"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
</p>

<p align="center">
  <a href="https://connectum.dev/en/guide/quickstart">Quickstart</a> &middot;
  <a href="https://connectum.dev">Documentation</a> &middot;
  <a href="https://github.com/Connectum-Framework/examples">Examples</a>
</p>

---

Connectum provides modular packages for gRPC and ConnectRPC services. Published packages contain compiled JavaScript; running an application's TypeScript source directly has separate runtime requirements. See [Runtime Compatibility](https://connectum.dev/en/guide/runtime-compatibility).

> This README documents the 1.3 release line. Installing from npm resolves the latest published package versions, which may predate changes on the main branch of this repository.

## Packages

| Package | What's inside |
|---------|---------------|
| [`@connectum/core`](packages/core) | `createServer()`, server lifecycle, TLS, protocol plugin system |
| [`@connectum/auth`](packages/auth) | JWT, gateway, session authentication; declarative RBAC; proto-based authorization |
| [`@connectum/interceptors`](packages/interceptors) | `createDefaultInterceptors()` — error handling, retry, circuit breaker, timeout, bulkhead, fallback, validation, logger |
| [`@connectum/healthcheck`](packages/healthcheck) | `Healthcheck()` — gRPC Health Check protocol + HTTP `/healthz`, `healthcheckManager` |
| [`@connectum/reflection`](packages/reflection) | `Reflection()` — gRPC Server Reflection v1/v1alpha, `collectFileProtos()` |
| [`@connectum/otel`](packages/otel) | `initProvider()` — OpenTelemetry tracing, metrics, logging; `traced()`, `getTracer()`, `getMeter()` |
| [`@connectum/cli`](packages/cli) | Scaffold projects, add services, and sync proto types from a running server |
| [`@connectum/events`](packages/events) | `createEventBus()` — proto-first pub/sub with middleware (retry, DLQ), `MemoryAdapter` |
| [`@connectum/events-nats`](packages/events-nats) | NATS JetStream adapter for EventBus |
| [`@connectum/events-kafka`](packages/events-kafka) | Apache Kafka / Redpanda adapter for EventBus |
| [`@connectum/events-redis`](packages/events-redis) | Redis Streams / Valkey adapter for EventBus |
| [`@connectum/events-amqp`](packages/events-amqp) | AMQP / RabbitMQ adapter for EventBus |
| [`@connectum/protoc-gen-catalog`](packages/protoc-gen-catalog) | Buf plugin generating the typed service catalog (`ctx.call` / `ctx.stream`) |
| [`@connectum/testing`](packages/testing) | `createTestServer()`, `mockResolver()`, `createMockContext()` — testing utilities |
| [`@connectum/test-fixtures`](packages/test-fixtures) | Transport-free mock requests, descriptors, streams, and assertion helpers |

## Documentation

**[connectum.dev](https://connectum.dev)** — [Quickstart](https://connectum.dev/en/guide/quickstart) · [Interceptors](https://connectum.dev/en/guide/interceptors) · [Health Checks](https://connectum.dev/en/guide/health-checks) · [Events](https://connectum.dev/en/guide/events) · [Observability](https://connectum.dev/en/guide/observability) · [API Testing](https://connectum.dev/en/guide/testing) · [ADR](https://connectum.dev/en/contributing/adr/)

## Contributing

```bash
git clone https://github.com/Connectum-Framework/connectum.git && cd connectum
pnpm install && pnpm test
```

[Contributing Guide](CONTRIBUTING.md) · [Development Setup](https://connectum.dev/en/contributing/development-setup) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[Apache License 2.0](LICENSE) · Built by [Highload.Zone](https://highload.zone)

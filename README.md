<p align="center">
  <img src="https://connectum.dev/assets/splash.png" alt="Connectum" width="600">
</p>

<p align="center">
  <strong>Production-ready gRPC/ConnectRPC framework for Node.js 25+</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D25-brightgreen" alt="Node.js"></a>
  <a href="https://nodejs.org/api/typescript.html"><img src="https://img.shields.io/badge/TypeScript-Native-blue" alt="TypeScript"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
</p>

<p align="center">
  <a href="https://connectum.dev/en/guide/quickstart">Quickstart</a> &middot;
  <a href="https://connectum.dev">Documentation</a> &middot;
  <a href="https://github.com/Connectum-Framework/examples">Examples</a>
</p>

---

Modular framework for building gRPC/ConnectRPC microservices. Native TypeScript execution via Node.js type stripping — no build step. Zero-config defaults with full customization through interceptors, protocols, and lifecycle hooks.

## Packages

| Package | What's inside |
|---------|---------------|
| [`@connectum/core`](packages/core) | `createServer()`, server lifecycle, TLS, protocol plugin system |
| [`@connectum/interceptors`](packages/interceptors) | `createDefaultInterceptors()` — error handling, retry, circuit breaker, timeout, bulkhead, fallback, validation, logger |
| [`@connectum/healthcheck`](packages/healthcheck) | `Healthcheck()` — gRPC Health Check protocol + HTTP `/healthz`, `healthcheckManager` |
| [`@connectum/reflection`](packages/reflection) | `Reflection()` — gRPC Server Reflection v1/v1alpha, `collectFileProtos()` |
| [`@connectum/otel`](packages/otel) | `initProvider()` — OpenTelemetry tracing, metrics, logging; `traced()`, `getTracer()`, `getMeter()` |
| [`@connectum/testing`](packages/testing) | `createTestServer()`, `mockInterceptor()` — testing utilities *(planned)* |

## Documentation

**[connectum.dev](https://connectum.dev)** — [Quickstart](https://connectum.dev/en/guide/quickstart) · [Interceptors](https://connectum.dev/en/guide/interceptors) · [Health Checks](https://connectum.dev/en/guide/health-checks) · [Observability](https://connectum.dev/en/guide/observability) · [API Testing](https://connectum.dev/en/guide/testing) · [ADR](https://connectum.dev/en/contributing/adr/)

## Contributing

```bash
git clone https://github.com/Connectum-Framework/connectum.git && cd connectum
pnpm install && pnpm test
```

[Contributing Guide](CONTRIBUTING.md) · [Development Setup](https://connectum.dev/en/contributing/development-setup) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[Apache License 2.0](LICENSE) · Built by [Highload.Zone](https://highload.zone)

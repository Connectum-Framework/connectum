# @connectum/interceptors

## 1.0.0-rc.1

## 1.0.0-beta.2

### Patch Changes

- Code review: critical fixes, ServerImpl decomposition, HealthcheckManager factory, unit tests

  **core:**

  - Fix Promise.race error swallowing in graceful shutdown
  - Fix error listener leak on synchronous throw in listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only in watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy in HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers in fallback response
  - Improve bulkhead error message
  - Consistent await in serializer
  - Fix double type cast in errorHandler

## 0.2.0-beta.1

### Minor Changes

- feat: `createMethodFilterInterceptor` (ADR-014) — per-service/per-method routing

### Patch Changes

- refactor!: production-ready default chain with resilience patterns (`errorHandler` -> `timeout` -> `bulkhead` -> `circuitBreaker` -> `retry` -> `fallback` -> `validation` -> `serializer`)
- refactor: retry switched to cockatiel (exponential backoff)
- refactor: remove domain-specific interceptors (`redact`, `addToken`, `validation` -> `@connectrpc/validate`)
- refactor: remove 30 biome-ignore directives, replace `any` with explicit types
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.

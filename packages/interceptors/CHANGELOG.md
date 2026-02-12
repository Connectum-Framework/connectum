# @connectum/interceptors

## 1.0.0-beta.2

### Patch Changes

- Code review: критические фиксы, декомпозиция ServerImpl, фабрика HealthcheckManager, unit-тесты

  **core:**

  - Fix Promise.race error swallowing в graceful shutdown
  - Fix error listener leak при синхронном throw в listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only в watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy в HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers в fallback response
  - Improve bulkhead error message
  - Consistent await в serializer
  - Fix double type cast в errorHandler

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

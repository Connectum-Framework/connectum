---
"@connectum/core": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
---

Code review: критические фиксы, декомпозиция ServerImpl, фабрика HealthcheckManager, unit-тесты

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

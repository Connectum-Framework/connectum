---
"@connectum/core": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
---

Code review: critical fixes, ServerImpl decomposition, HealthcheckManager factory, unit tests

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

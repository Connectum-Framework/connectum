# @connectum/healthcheck

## 1.0.0-rc.3

### Patch Changes

- [#13](https://github.com/Connectum-Framework/connectum/pull/13) [`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06) Thanks [@intech](https://github.com/intech)! - CI/CD and documentation improvements

  **CI/CD:**

  - Switch to OIDC trusted publishers (no NPM_TOKEN)
  - Add PR snapshot publishing via pkg-pr-new
  - Fix provenance: use NPM_CONFIG_PROVENANCE env var instead of CLI argument

  **Docs:**

  - Fix healthcheck README: clarify Check/Watch (standard) + List (extension), license MIT → Apache-2.0
  - Fix httpHandler.ts JSDoc: HTTP_HEALTH_ENABLED → HealthcheckOptions.httpEnabled
  - Add comprehensive reflection README (API, grpcurl, buf curl usage)

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06)]:
  - @connectum/core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- Updated dependencies [[`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e)]:
  - @connectum/core@1.0.0-rc.2

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

- Updated dependencies
- Updated dependencies [4e784c1]
  - @connectum/core@1.0.0-beta.2

## 0.2.0-beta.1

### Patch Changes

- refactor!: singleton manager, embed proto, gRPC spec compliance
- refactor: rename `withHealthcheck` -> `Healthcheck` API
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.

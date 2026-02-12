# Changelog

All notable changes to the Connectum monorepo will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the root changelog consolidating changes across all `@connectum/*` packages.
For per-package details, see each package's own `CHANGELOG.md`.

## [0.2.0-beta.1] - 2026-02-12

### Added

- **@connectum/core**: 5-phase graceful shutdown with `shutdownSignal` and `ShutdownManager` supporting dependency-ordered hooks
- **@connectum/core**: `builtinInterceptors` option -- custom interceptors now append after built-in ones
- **@connectum/interceptors**: `createMethodFilterInterceptor` for per-service and per-method routing (ADR-014)
- **@connectum/interceptors**: `createDefaultInterceptors()` factory for standard interceptor chain
- **@connectum/otel**: `createOtelClientInterceptor` for client-side RPC tracing with context propagation
- **@connectum/otel**: `getLogger()` -- unified correlated logger with auto-injected service name from active span (info/warn/error/debug + raw emit)
- **@connectum/healthcheck**: extracted as a standalone protocol package
- **@connectum/reflection**: extracted as a standalone protocol package
- **@connectum/cli**: new package -- CLI tools for proto sync with integration tests

### Changed

- **@connectum/interceptors**: production-ready default chain with resilience patterns (errorHandler -> timeout -> bulkhead -> circuitBreaker -> retry -> fallback -> validation -> serializer)
- **@connectum/interceptors**: retry logic switched to cockatiel library (exponential backoff)
- **@connectum/interceptors**: removed domain-specific interceptors (redact, addToken); validation delegated to `@connectrpc/validate`
- **@connectum/interceptors**: removed 30 biome-ignore directives, replaced `any` with explicit types
- **@connectum/otel**: unified OTel interceptor, tracing logic moved out of `@connectum/interceptors`
- **@connectum/healthcheck**: renamed `withHealthcheck` to `Healthcheck` API; singleton manager with embedded proto, gRPC spec compliance
- **@connectum/reflection**: renamed `withReflection` to `Reflection` API
- **@connectum/testing**: updated dependencies

### Breaking Changes

- **@connectum/core**: uniform registration API -- removed deprecated code paths
- **@connectum/interceptors**: default interceptor chain restructured with resilience patterns; domain-specific interceptors removed
- **@connectum/healthcheck**: singleton manager replaces previous API; proto definitions embedded in the package
- **@connectum/reflection**: `withReflection()` renamed to `Reflection()`
- **@connectum/proto**: removed gRPC health and reflection protos (now embedded in respective packages), dropped WKT exports, removed `extensions.ts`
- **@connectum/utilities**: removed lifecycle and shutdown utilities (moved to `@connectum/core`)

## [0.2.0-alpha.2] - 2026-02-06

### Added

- New `createServer()` API with explicit lifecycle control and event emitter (replaces the previous server factory)
- Protocol plugin system for healthcheck and reflection registration
- 9-package architecture across 4 layers (Layer 0-3)
- Migration to buf CLI v2 for proto generation
- GitHub organization [Connectum-Framework](https://github.com/Connectum-Framework) with multi-repo structure (connectum, docs, examples)

### Changed

- Renamed all packages from legacy namespace to `@connectum/*`
- Restructured monorepo into 4 dependency layers: independent core (Layer 0), protocol implementations (Layer 1), integration (Layer 2), development tools (Layer 3)
- Removed domain-specific packages (`database`, `observability`) -- framework is now generic
- Switched to native TypeScript execution on Node.js 25.2.0+ (zero build step)
- Adopted Biome for linting and formatting
- Adopted Turborepo for build orchestration

### Breaking Changes

- All package names changed to `@connectum/*` scope
- Server creation uses `createServer()` with named options instead of the previous factory
- Enum usage replaced with `const` objects and `as const`
- Explicit `import type` required (`verbatimModuleSyntax`)
- `.js` extensions required in all import paths

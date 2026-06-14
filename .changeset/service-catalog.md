---
"@connectum/core": major
---

feat(core)!: service catalog — declarative cross-service calls

Adds the **service catalog** layer on top of the in-process transport: a
standardized DX for calling other services (local or remote) without hand-rolling
an endpoint registry, a transport cache, or per-call-site interceptor chains.

New public API (additive):

- **`defineService(descriptor, handlers)` / `defineLazyService(descriptor, factory)`** —
  the canonical way to register a service. They return a `ServiceDefinition`
  (`{ descriptor, register }`); `createServer({ services })` now takes
  `ServiceDefinition[]`. `defineLazyService` instantiates handlers only when the
  service is mounted locally.
- **Catalog primitives** — `ServiceCatalog` type, `defineCatalog`, and
  `mergeCatalogs` (with a mandatory runtime duplicate-`typeName` guard), plus the
  `ConnectumCallMap` / `ConnectumStreamMap` module-augmentation targets that make
  positional `ctx.call(...)` / `ctx.stream(...)` type-safe.
- **`RemoteResolver`** type and built-in helpers `singleTransportResolver`,
  `mapResolver` — resolve a remote service to a `Transport`.
- **`enabledServices` helpers** — `parseServicesEnv`, `matchServicesPattern`,
  `mergeEnabledServices` for env-driven local activation (full proto typeNames).

**BREAKING** (pre-publish, lands before the first stable release): the legacy
`ServiceRoute = (router) => void` registration form is removed in favour of
`defineService`. Migrate `(router) => router.service(Desc, impl)` to
`defineService(Desc, impl)`.

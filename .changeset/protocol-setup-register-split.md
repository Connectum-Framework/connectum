---
"@connectum/core": minor
"@connectum/healthcheck": minor
"@connectum/reflection": minor
---

fix: health, reflection and lazy services stay consistent across the HTTP and in-process transports

A server builds one router for the HTTP adapter and one per in-process transport (`server.localClient()`, the catalog transport behind `ctx.call`). Every extra router re-ran one-time work:

- **Healthcheck** — the first in-process call re-initialized the health manager: application services were dropped and `grpc.health.v1.Health` itself was tracked as `UNKNOWN`, so overall health fell from `SERVING` to `NOT_SERVING` and readiness probes started failing after the first `ctx.call` / `localClient()`. Overall health and the tracked service set are now unaffected by in-process transports.
- **Reflection** — the in-process listing was rebuilt from the grown registry and additionally advertised `grpc.reflection.v1.ServerReflection` / `grpc.reflection.v1alpha.ServerReflection`, diverging from the HTTP listing. Both transports now serve the same descriptor set.
- **`defineLazyService`** — `factory` ran once per router, so HTTP and in-process callers reached different implementation instances and resources opened by the factory were duplicated. `factory` now runs once per server; the same definition mounted on two servers still yields one instance per server.

**BREAKING (custom protocol authors only):** `ProtocolRegistration` separates one-time initialization from route registration. The new optional `setup(context)` runs exactly once per server, immediately before the protocol's first `register`, with a frozen snapshot of the registry (application services plus the services of protocols listed earlier). `register(router)` no longer receives `context`, runs once per router, and must only add routes. Move everything that reads `context` or has side effects from `register` into `setup`. A two-argument `register` no longer type-checks. Applications that only use the built-in `Healthcheck()` / `Reflection()` need no changes.

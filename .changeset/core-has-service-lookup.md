---
"@connectum/core": patch
---

fix: `server.hasService()` no longer builds the routes for a service the application defines. Before, the first call ran every `defineLazyService` factory and made `addService()`, `addInterceptor()` and `addProtocol()` throw. Now a service from `services` / `addService()` (filtered by `enabledServices`) is answered from its definition. Only a descriptor that no definition covers, while protocols are registered, still builds the routes, because what a protocol mounts is known only then; the "routes have already been materialized" errors now name `hasService()` among the causes.

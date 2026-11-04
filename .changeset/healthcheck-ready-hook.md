---
"@connectum/healthcheck": minor
---

feat: `Healthcheck()` tracks the same services whatever its place in `protocols`. It completes its tracked set in the protocol `ready` hook, after every protocol has registered. Before, it tracked only what was registered before it, so the services of a protocol listed after Healthcheck were never tracked. Now the application services and the services of custom protocols are tracked in every ordering. Never tracked, as before: its own `grpc.health.v1.Health`, the infrastructure services `grpc.reflection.v1` and `v1alpha`, and a service that is only declared in a mounted file. New tracked services start as `UNKNOWN` as before; the `manager` option and the shared `healthcheckManager` behave as before. The default `[Healthcheck(), Reflection()]` answers exactly what it answered.

The one ordering that changes is `[Reflection(), Healthcheck()]`: it used to list both reflection services in `Health/List` (a side effect of the order), and no longer does. A custom protocol listed after `Healthcheck()` now appears in `Health/List`, `UNKNOWN` until `healthcheckManager.update(...)` marks it, and counts in the overall status. A protocol that wraps `Healthcheck()` must forward `ready` as well as `setup` and `register`; without it Health tracks only the services registered before the wrapper.

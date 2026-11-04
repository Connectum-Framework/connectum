---
"@connectum/healthcheck": minor
---

feat: `Healthcheck()` tracks the same services whatever its place in `protocols`. It completes its tracked set in the protocol `ready` hook, after every protocol has registered. Before, it tracked only what was registered before it: `[Reflection(), Healthcheck()]` listed both reflection services in `grpc.health.v1.Health/List`, `[Healthcheck(), Reflection()]` listed none, and the services of a protocol listed after Healthcheck were never tracked. Now every ordering answers the same `List` and `Check`: the application services plus the services of all protocols, the reflection services included. The `grpc.health.v1.Health` service itself is still never tracked, a service that is only declared in a mounted file is still not tracked, and a new tracked service starts as `UNKNOWN` as before. The `manager` option and the shared `healthcheckManager` behave as before.

This changes the output of `Health/List` (and what `Check` answers) for servers that list `Healthcheck()` before `Reflection()` or before a custom protocol: those services now appear, `UNKNOWN` until `healthcheckManager.update(...)` marks them, and they count in the overall (empty-name) status. A protocol that wraps `Healthcheck()` must forward `ready` as well as `setup` and `register`; without it Health tracks only the services registered before the wrapper.

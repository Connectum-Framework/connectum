---
"@connectum/core": minor
"@connectum/reflection": minor
---

feat: the order of `protocols` no longer changes what reflection shows. `ProtocolRegistration` has a new optional `ready(context)` hook that `createServer` calls once, after every protocol has registered, with the complete service set (a protocol without it is untouched). `Reflection()` builds its listing and descriptors there, so `[Reflection(), Healthcheck()]` and `[Healthcheck(), Reflection()]` list the same services, and services of protocols placed after `Reflection()` are now listed and describable instead of being missing (`grpc.health.v1.Health` could not be found by `buf curl --reflect` when `Reflection()` came first). The reflection services themselves stay out of the listing. A protocol that wraps `Reflection()` and forwards only `setup` and `register` keeps the old listing; forward `ready` as well to get the new one.

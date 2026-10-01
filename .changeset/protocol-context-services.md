---
"@connectum/core": minor
"@connectum/healthcheck": patch
---

`ProtocolContext` gains `services`: the services mounted before the protocol, in registration order, as a frozen snapshot next to `registry`.

`registry` holds the files of the mounted services, and a file may declare more services than are mounted (several services in one proto file, or `enabledServices` mounting a subset). Protocols that report served services now read `services`:

- `@connectum/healthcheck` tracks only mounted services: an unmounted service declared in the same file as a mounted one no longer appears in `List`, and `Check` for it answers `NOT_FOUND`.
- `@connectum/reflection` lists only mounted services in `list_services`.

Custom protocols that derived service names from `context.registry[].services` should switch to `context.services`. Code that builds a `ProtocolContext` by hand (tests calling `setup` directly) must now pass `services` as well.

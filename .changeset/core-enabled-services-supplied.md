---
"@connectum/core": minor
---

fix: `start()` now checks every `enabledServices` entry against the services passed to `createServer()` (and added with `addService()`), also when no `catalog` is configured. Before, a misspelled type name (for example from an environment variable) started a server that mounted nothing and answered every call with `unimplemented`; now `start()` rejects with `CatalogConfigError` naming the unknown entries and the type names available. A list that names only supplied services, and an empty list, behave as before. An entry that names a catalog service which is not in `services` is rejected as well, because it mounts nothing either.

---
"@connectum/core": minor
---

fix: the catalog and resolver options are checked where they are accepted, not only in `defineCatalog()`. `createServer({ catalog })` and `createCatalogClient({ catalog })` throw `CatalogConfigError` for a catalog whose key differs from its descriptor's `typeName` (same message form as `defineCatalog`), which previously let `enabledServices: ["wrong"]` match and mount nothing. `createCatalogClient()` throws when `resolver` is missing or not a function. `dnsResolver()` throws when `template` is not a non-empty string or `createTransport` is not a function, and `perServiceEnvResolver()` / `mapResolver()` throw when the map is not an object. Valid configurations behave as before.

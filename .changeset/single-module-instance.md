---
"@connectum/otel": patch
"@connectum/core": patch
"@connectum/interceptors": patch
"@connectum/cli": patch
"@connectum/testing": patch
"@connectum/test-fixtures": patch
---

Each package now evaluates its modules once, whichever subpath you import.

These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.

The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

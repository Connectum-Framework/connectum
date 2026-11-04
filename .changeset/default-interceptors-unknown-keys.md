---
"@connectum/interceptors": minor
---

fix: `createDefaultInterceptors` now throws a `TypeError` for an option key it does not know, naming the key and listing the known ones (`errorHandler`, `timeout`, `bulkhead`, `circuitBreaker`, `retry`, `fallback`, `validation`, `serializer`). Before, a mistyped key such as `timout` or `circuitbreaker` was ignored, so the protection the caller asked for was silently off. Keys such as `logger` and `methodFilter`, which are not part of the default chain, are refused the same way: create those interceptors with their own factories. A `null` or otherwise non-object argument is refused too, with an error that names the function instead of a raw `Cannot read properties of null`. Calls that pass only known keys behave as before.

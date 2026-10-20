---
"@connectum/core": patch
---

fix: `mapResolver` is an exact allow-list. A `typeName` the map does not own, including the names of `Object.prototype` members (`constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__`), now resolves to `null` (the call fails with `Code.Unavailable`) instead of returning a member inherited from `Object.prototype`. A key the map owns still resolves, whatever its name.

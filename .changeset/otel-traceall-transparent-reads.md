---
"@connectum/otel": patch
---

fix: `traceAll()` no longer breaks property reads on the object it wraps. A getter over a `#private` field, `Map.size` and `Set.size` used to throw a `TypeError` because the getter ran with the proxy as `this`; getters now run with the original object. Every read of a method on a frozen object (an own property that is neither writable nor configurable) used to throw as well; such a method is now returned as it is. A method that cannot be wrapped in a proxy for this reason is not traced.

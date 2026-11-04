---
"@connectum/core": minor
---

fix: `server.onShutdown()` now rejects arguments that match none of its three forms with a `TypeError` that starts with `onShutdown(` and names the problem, where it used to fail with `TypeError: dependencies is not iterable` (the text differs on Bun). A call without a hook function, a non-string module name, dependencies that are not an array of strings, and a string where the array of dependencies belongs all throw at registration. The last one used to be spread into one dependency per character, so `onShutdown('x', 'db', fn)` ran `x` without waiting for `db`. Calls that match the documented forms behave as before, and a dependency on a name nobody registered is still accepted.

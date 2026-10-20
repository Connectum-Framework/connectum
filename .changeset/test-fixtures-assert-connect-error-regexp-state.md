---
"@connectum/test-fixtures": patch
---

fix: `assertConnectError` gives the same verdict when the same `RegExp` object with the `g` or `y` flag is passed more than once. Such a pattern keeps `lastIndex` between `test()` calls, so the second assertion against a matching message failed. The message is now matched against a copy of the pattern without those flags, and the caller's `lastIndex` is no longer moved.

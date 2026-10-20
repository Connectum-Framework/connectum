---
"@connectum/test-fixtures": patch
---

fix: `assertConnectError` gives the same verdict when the same `RegExp` object with the `g` or `y` flag is passed more than once. Such a pattern keeps `lastIndex` between `test()` calls, so the second assertion against a matching message failed. The message is now matched against a fresh copy of the pattern on every call, so the verdict depends on the message only and the caller's `lastIndex` is no longer moved. The copy keeps every flag: a sticky pattern (`/boom/y`) still has to match at the start of the message.

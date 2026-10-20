---
"@connectum/testing": patch
---

fix: `assertConnectError`, re-exported from `@connectum/test-fixtures`, gives the same verdict when the same `RegExp` object with the `g` or `y` flag is passed more than once (the second assertion against a matching message used to fail).

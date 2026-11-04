---
"@connectum/core": patch
---

fix: `createServer({ propagateHeaders })` copies the list when the server is created, and `defaultPropagateHeaders` is frozen. Before, pushing `"authorization"` into the array you had passed (or into `defaultPropagateHeaders`) after `createServer()` started forwarding credentials to downstream calls. Spreading `defaultPropagateHeaders` into your own list works as before.

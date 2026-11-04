---
"@connectum/core": minor
---

fix: `createServer({ propagateHeaders })` now checks its entries when the server is created. A name that is not a valid HTTP header name (`"x y"`, `""`, a pseudo-header such as `":authority"`) or a value that is not an array of strings throws a `TypeError` that names `propagateHeaders` and the entry. Before, the server started and every `ctx.call` threw `TypeError: Headers.get: ... is an invalid header name`, which reached the caller as `internal`. Valid lists, including `defaultPropagateHeaders` with your own names added, behave as before.

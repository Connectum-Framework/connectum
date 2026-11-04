---
"@connectum/core": minor
---

fix: `createServer()` now validates `port` and `host` at creation. A `port` that is not an integer from 0 to 65535 (a string such as `"abc"`, which Node treated as a Unix socket path, included) throws a `TypeError` or `RangeError` naming `port`; an empty or non-string `host`, which used to bind every interface, throws an error naming `host`. Valid values behave as before. Code that passed a numeric string as `port` must pass a number.

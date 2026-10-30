---
"@connectum/testing": minor
---

feat: `CreateTestServerOptions` gets `shutdown: { timeout }`, the longest wait in milliseconds that `close()` gives to calls still in flight. A unary handler that does not observe `ctx.signal` kept `close()` waiting for the server's default of 30 s (logging `Shutdown timeout (30000ms) exceeded`), and the helper had no way to shorten it; a test with such a handler can now set a short timeout, and the unfinished call fails on the client when it expires. Without the option nothing changes. The value is validated by `createServer()` (an integer from 0); any other key of `shutdown` throws a `TypeError` naming it, because only `timeout` is offered.

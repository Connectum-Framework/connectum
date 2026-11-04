---
"@connectum/core": minor
"@connectum/testing": minor
---

docs: leaving a `for await` loop over a streaming response with `break` now ends the call, on `server.localClient()` and over HTTP alike.

With `@connectrpc/connect` 2.3.0 and later the response iterator of a server-streaming or bidirectional call has `return()` and `throw()`. A `break` (or a thrown error in the loop body) calls `return()`, which aborts the call's signal: the handler's `ctx.signal` aborts and its `finally` runs without any further abort by the caller and without `server.stop()`. Client-side interceptors see their response stream end without an error, since the caller chose to stop; only the handler sees the call as cancelled. Before, a `break` left the handler parked at its last `yield` until the call was ended some other way.

`createLocalTransport()`, `Server.localClient()` and the cancellation notes in their documentation now describe this. Handlers that relied on a stream surviving the caller leaving the loop must keep the caller reading, or move the work out of the stream handler. `ctx.stream()` consumers get the same behaviour for the target call. No Connectum code path changed: the behaviour comes from the Connect client, so it applies on both transports by construction.

The peer ranges of `@connectrpc/connect` and `@connectrpc/connect-node` in `@connectum/core` and `@connectum/testing` are raised from `^2.2.0` to `^2.3.0`, which `createServer()` enforces at start-up. Two further 2.3.0 behaviours are visible: a client-side response wrapper parked at `yield` is resumed when the call is aborted, and on a kept-alive HTTP/1 connection a call rejected by `requestGate` has up to 256 KiB of its unread body discarded by the transport (the handler still never parses it).

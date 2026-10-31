---
"@connectum/core": minor
---

fix: `server.stop()` no longer ends a server stream that is still sending with a successful end of stream. The response iterator the framework finishes on abort used to complete normally, so a Connect client got an end-stream frame without an error and a gRPC client got `grpc-status: 0`, with a truncated list of messages that looked complete. The client now receives the messages already sent and then an `unavailable` error (`the server is shutting down`) for a server stop, the abort reason's own error for a deadline, and `canceled` for a client abort. This holds over HTTP (Connect and gRPC protocols) and for in-process calls. A handler that returns by itself after it sees `ctx.signal` abort still ends the call normally, and a handler that rethrows the abort reason is still reported as `canceled`. A client that retried only on errors now sees `unavailable` where it used to see success.

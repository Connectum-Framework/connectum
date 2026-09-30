---
"@connectum/core": minor
"@connectum/testing": minor
---

feat(core): server-level `requestGate` and `readMaxBytes` in `createServer()`

- **`requestGate`** is Connect's gate, set as a server-wide default. It receives the call's `HandlerContext` after the headers arrive and before any request message is received, decompressed or parsed. Throw a `ConnectError` to reject the call without reading the body.
- **`readMaxBytes`** is a server-wide per-message read limit. A larger message ends with `ResourceExhausted` before the handler runs.
- **Both are opt-in and unset by default.** Servers that do not set them behave exactly as before.
- **Identical on both transports.** Both options apply the same way over HTTP and in-process: `server.localClient()`, `createLocalTransport()`, and `ctx.call` / `ctx.stream` to a local service.
  - There is no in-process exemption. An internal `ctx.call` carries only the headers you forward with `propagateHeaders` or `outgoingInterceptors`.
- **Service values override.** A service's own `requestGate` or `readMaxBytes` in `ServiceOptions` replaces the server default for that service. They are not composed, and the server value is not a ceiling.
- **Gate errors bypass `errorHandler`.** A gate runs before the server interceptors. A thrown `ConnectError` reaches the client as thrown, so give it a client-safe message. Anything else is replaced by Connect with `internal error` (`Code.Internal`); its text never reaches the client.
- **Invalid values fail fast.** `createServer()` throws a `RangeError` naming the option when `readMaxBytes` is not an integer from 1 to 4294967295 (`0`, negatives, fractions, `NaN`, `Infinity`), and a `TypeError` for a non-number `readMaxBytes` or a non-function `requestGate`. Left to Connect, `NaN` would silently disable the limit.
- **No server-side telemetry for rejections.** A rejected call produces no server span, metric or log entry. Wrap the gate yourself to audit rejections.
- **What the gate covers.** Every RPC on the router is gated, including gRPC Health and Reflection. HTTP endpoints served by protocol HTTP handlers, such as `/healthz`, are not.
- **Cancellation is cooperative.** `context.signal` aborts on the call's deadline and on client cancellation, and on server shutdown for HTTP calls only. In-process calls are still not aborted by `server.stop()`.
- **Security fix.** HTTP requests now have a forged `connectum-internal-transport` header deleted before Connect builds the request. Previously it was removed only by an interceptor, which runs after a gate. Any gate, server-level or per-service, could therefore observe a forged in-process marker.
- **`@connectum/testing`:**
  - `transportParityTest()` accepts `requestGate` and `readMaxBytes` and applies them to both servers.
  - `defaultCompare` treats one documented difference as equal: a `readMaxBytes` diagnostic text that includes the observed size on one transport and omits it on the other, for the same configured limit.

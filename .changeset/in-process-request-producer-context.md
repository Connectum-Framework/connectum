---
"@connectum/core": patch
---

fix: in-process calls advance the caller's request stream in the caller's async context.

In a client-streaming or bidirectional call over `server.localClient()`, `createLocalTransport()`, `ctx.stream` or `server.client()`, the handler pulls the caller's request generator directly, so the generator ran under the `AsyncLocalStorage` values that a server interceptor had scoped around the handler: with `@connectum/auth` the caller's own code observed the identity verified for the callee (for client-streaming calls since 1.0; for bidirectional calls since the streaming identity fix in this release), and with `@connectum/otel` it ran under the server span. The transport now binds the creation of the request iterator and each of its `next`, `return` and `throw` to the context in which the call was made, below the client-side interceptors, as the HTTP transport's pump does: the generator sees the caller's identity, the client span and every other value of the call site. Handlers, server-side interceptors, the identity they verify and their spans are unchanged. On cancellation the generator's `return` and `throw` still run in the context that raised the abort, on both transports. No API changes.

---
"@connectum/otel": minor
---

fix: the server span is now the active span inside server-streaming and bidirectional handlers.

`trace.getActiveSpan()` used to be empty in such a handler over HTTP (and returned the caller's or the client span in-process), in every phase: at the start, after an `await`, after a `yield` and in `finally`. A span the handler started, including through `traced()`, was therefore not a child of the server span. `createOtelInterceptor()` now runs the creation of the response stream and each of its `next`, `return` and `throw` steps in the context that carries the server span, so the whole handler runs under it and its spans are parented to it. Unary and client-streaming handlers, span names, attributes, events, status and metrics are unchanged. The scope ends with each step: the code that consumes the stream keeps its own active span and concurrent streams stay separate.

The helper `scopeAsyncIterable` is exported from `@connectum/otel/shared` next to `wrapAsyncIterable`; no other API changes.

The request stream is pulled by code below the interceptor (the handler, or an interceptor placed after it), so it already runs under the server span and is not re-scoped: an interceptor placed before `createOtelInterceptor()` that wraps the request stream still sees the server span while it is pulled, as before. Wrappers of the response stream run under the server span only when they are placed after `createOtelInterceptor()`; put `createLoggerInterceptor()` after it to have its response and completion records correlated with the span. In-process, the generator that produces the request messages of a bidirectional call now also runs under the server span, as it already did for client-streaming calls.

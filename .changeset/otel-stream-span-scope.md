---
"@connectum/otel": patch
---

fix: the server span is now the active span inside server-streaming and bidirectional handlers.

`trace.getActiveSpan()` used to be empty in such a handler over HTTP (and returned the caller's or the client span in-process), in every phase: at the start, after an `await`, after a `yield` and in `finally`. A span the handler started, including through `traced()`, was therefore not a child of the server span. `createOtelInterceptor()` now runs the creation of the response stream and each of its `next`, `return` and `throw` steps in the context that carries the server span, so the whole handler runs under it and its spans are parented to it. Unary and client-streaming handlers, span names, attributes, events, status and metrics are unchanged. The scope ends with each step: the code that consumes the stream keeps its own active span, concurrent streams stay separate, and a finished stream keeps nothing reachable.

The request stream of client-streaming and bidirectional calls is now pulled in the caller's context instead of the server span's. In-process, the generator that produces the request messages used to run under the server span in client-streaming calls; it now runs under the caller's span (or the client span with `createOtelClientInterceptor()`), exactly as it does over HTTP. Handlers see no difference.

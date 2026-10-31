---
"@connectum/testing": patch
---

fix: an exception thrown by a `mockService` implementation that is not a `ConnectError` (a `TypeError` from a typo in the mock, a rejected promise, a thrown string) no longer reaches the caller of `ctx.call` / `ctx.stream` / the mock transport as the anonymous `[internal] internal error` with no `cause`. It now arrives as a `ConnectError` with code `Internal`, the exception's own message and the exception itself as `cause`; this holds for unary, client-streaming, server-streaming and bidirectional mocks, and a failure in the middle of a stream is reported after the items that were already delivered. A `ConnectError` thrown by the mock still answers unchanged.

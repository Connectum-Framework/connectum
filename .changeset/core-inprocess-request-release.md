---
"@connectum/core": patch
---

fix: cancelling an in-process client-streaming or bidirectional call whose handler was waiting for the next request message left the handler suspended in its `for await` over the requests, and its `finally` never ran, while over HTTP/2 the same cancellation ends the handler. The request stream now ends when the caller cancels the call (the caller's `AbortSignal` or a deadline), so the handler leaves its loop and runs its `finally`, and the caller's request iterator is finished. This also releases the callee of a `ctx.stream(...)` handle that was opened and never closed once the call that opened it is cancelled. `server.stop()` does not end an upload that is still being sent, on either transport.

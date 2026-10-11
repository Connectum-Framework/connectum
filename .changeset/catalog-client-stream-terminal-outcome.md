---
"@connectum/core": patch
---

fix: a catalog client-streaming `close()` now waits for the call's final status

`ClientStreamHandle.close()` of `ctx.stream` and `createCatalogClient().stream` used to resolve at the first response message and never read the rest of the response stream. A failure that followed the response was swallowed, a surplus response was ignored, and an OpenTelemetry client span (`createOtelClientInterceptor`) was started but never ended, because that interceptor ends a streaming call's span only when the response stream ends.

`close()` now reads the response stream to its end, as a standard `@connectrpc/connect` client-streaming call does: it resolves with the response when exactly one arrived and the call succeeded, and rejects when there was no response (`Internal`, unchanged), more than one response (`Internal`), or a failure after the response (the failure itself). The client span now starts, ends and exports once (OK on success, ERROR on failure or cancellation).

Observable change: `close()` no longer settles when the response arrives but when the call finishes. A server that delays its final status holds `close()` until that status arrives, the caller aborts the signal, or the deadline passes. Code that relied on a late failure being swallowed will now see it. No API, option or type changes.

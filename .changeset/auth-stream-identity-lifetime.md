---
"@connectum/auth": patch
"@connectum/core": patch
---

fix: the verified identity now stays available to server-streaming and bidirectional handlers for the whole call.

`getAuthContext()` and `requireAuthContext()` used to return `undefined` in a generator handler as soon as it suspended (after the first `await` or `yield`, and in `finally`), and over `server.localClient()` the handler could instead see the identity held by the caller of the local client. The authentication interceptors (`createAuthInterceptor`, `createJwtAuthInterceptor`, `createSessionAuthInterceptor`, `createGatewayAuthInterceptor`, `createInternalAuthInterceptor`, cached or not) now scope the identity to the creation of the response stream and to each of its `next`, `return` and `throw` operations, so every part of the handler runs under the identity verified for its own call. Unary and client-streaming calls, rejected credentials, response headers and trailers, message order and the early-end semantics are unchanged.

Code that worked around this (capturing the identity before the first `await`, reading the propagated headers, or re-entering `authContextStorage.run` around the iterator) keeps working and can be removed.

`@connectum/core` binds the cleanup it triggers when a streaming call is cancelled (client abort, deadline, server shutdown) to the context in which the call's stream was created, so the handler's `finally` runs under the call's own `AsyncLocalStorage` values instead of those of whatever raised the abort. No public API changes.

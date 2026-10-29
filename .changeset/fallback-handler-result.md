---
"@connectum/interceptors": minor
---

fix: the value a `fallback` handler returns must now be the response message of the called method. A plain object with that message's fields (the form the documentation shows) is turned into the message, so `handler: () => ({ items: [] })` works; a message made with `create(OutputSchema, ...)` is used as it is. `undefined`, `null`, a string, an object with a field the type does not have, or a field of the wrong type fail the call with a `TypeError` that names `createFallbackInterceptor` and the expected type, instead of a `serialize binary: ...` text from the protocol layer. Behind the error handler the client receives `Internal: internal error` and `onError` sees the full text. On a client transport a plain object with fields the response type does not have was returned to the application as it was; it is now refused.

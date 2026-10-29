---
"@connectum/interceptors": patch
---

fix: an `async` `onError` callback of `createErrorHandlerInterceptor` that rejects no longer ends the Node process with an unhandled rejection. The interceptor handles the rejection and writes the first failure once to `console.error`; later failures of the callback are not reported again. The error the caller receives is unchanged. The `onError` type now states that the callback may return a promise.

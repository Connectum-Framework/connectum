---
"@connectum/interceptors": patch
---

fix: when the `onError` callback of `createErrorHandlerInterceptor` throws, the client now receives the error the handler threw (a `ConnectError` unchanged, a `SanitizableError` with its `clientMessage` and code) instead of `Internal: internal error`. The first failure of the callback is written once to `console.error`; later ones are not reported again.

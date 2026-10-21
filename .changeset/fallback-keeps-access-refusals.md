---
"@connectum/interceptors": patch
---

fix: `createFallbackInterceptor` no longer answers a refusal of access with the fallback value. A failure with the code `Unauthenticated` or `PermissionDenied` is rethrown as it is and the fallback handler is not called for it, wherever the authentication or authorization interceptor stands relative to the fallback interceptor. Failures with other codes, and errors that are not `ConnectError`, keep using the fallback. A configuration whose fallback handler used to answer a refusal of its own service now returns the refusal to the caller. Put the authentication and authorization interceptors in front of the default interceptors, as the guides show.

---
"@connectum/auth": patch
---

fix(auth): a denial by an authorization rule or a proto `requires` now reaches the client as `PermissionDenied` even without `createErrorHandlerInterceptor` in front. `AuthzDeniedError` had a `name` that Connect's `instanceof ConnectError` check rejects, so the server turned it into `internal`. The error is now a plain `ConnectError` that carries the same `name`, `ruleName`, `authzDetails`, `clientMessage` and `serverDetails`, so `error.name`, `code` and the error handler output are unchanged; `error instanceof ConnectError` is now true, and `error instanceof AuthzDeniedError` is true only for these errors (before it was false for them and true for every `ConnectError`). Without the error handler the client message is `Access denied by rule: <rule>`; put the handler first to send only `Access denied`. A class that extends `AuthzDeniedError` no longer gets its own prototype.

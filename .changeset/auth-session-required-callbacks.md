---
"@connectum/auth": minor
---

fix(auth): `createSessionAuthInterceptor` now checks its callbacks when it is created and throws a `TypeError` that names the factory and the option: `verifySession` and `mapSession` must be functions, and `extractToken`, when set, must be a function. Before, a missing `verifySession` or `mapSession` produced an interceptor that answered every request with `Unauthenticated: Session verification failed` or `Session mapping failed`, whatever the credential, and an `extractToken` that was not a function ended every request with `internal`. This completes the creation-time checks of the generic, gateway and internal interceptors.

**BREAKING** only for code that created the session interceptor without a usable callback; such an interceptor rejected every call already. Pass the callback, or do not register the interceptor. See the migration guide `auth-authorization-validation`.

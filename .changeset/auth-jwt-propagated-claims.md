---
"@connectum/auth": minor
---

fix(security): `createJwtAuthInterceptor` now accepts `propagatedClaims`, as `createAuthInterceptor` and `createSessionAuthInterceptor` do. Before, the option was ignored without an error, so with `propagateHeaders: true` every claim of the token (email, phone, custom claims) was written to `x-auth-claims`; now only the listed claims are.

`propagatedClaims` is also checked when the interceptor is created, in all three factories: a value that is not an array of non-empty strings throws a `TypeError` that names the factory. Before, a string such as `"org_id"` was searched as text, so a mistaken value sent more claims than intended. Pass an array: `propagatedClaims: ["org_id"]`.

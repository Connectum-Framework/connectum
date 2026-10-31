---
"@connectum/auth": minor
---

fix(security): the `authorize` callback of `createAuthzInterceptor` and `createProtoAuthzInterceptor` now allows a call only when it returns (or resolves to) exactly `true`. Before, any truthy value allowed: the string `"false"` or `"0"` read from a claim, `1`, `{}`. Every other result is `PermissionDenied: Access denied`, as `false` already was.

**BREAKING** for a callback that returned a truthy non-boolean on purpose: return `true`, for example `authorize: (ctx) => ctx.claims.isAdmin === true`. See the migration guide `auth-authorization-validation`.

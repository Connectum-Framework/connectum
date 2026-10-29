---
"@connectum/auth": patch
---

fix: with the `cache` option of `createAuthInterceptor` and `createSessionAuthInterceptor`, every request now receives its own copy of the cached `AuthContext` (the context, `roles`, `scopes`, `claims` with nested plain objects and arrays, and `expiresAt`). Before, the cache returned the same mutable object to every request with the same credential, so a handler that did `getAuthContext().roles.push("admin")` granted that role to later requests presenting the same token. A handler that changes its context keeps working, as it does without a cache; the change stays inside its request. Each cache hit costs one pass over the identity.

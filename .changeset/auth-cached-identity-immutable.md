---
"@connectum/auth": minor
---

fix: with the `cache` option of `createAuthInterceptor` and `createSessionAuthInterceptor`, the identity a handler receives is now a frozen snapshot: the `AuthContext`, its `roles`, `scopes` and `claims` (nested plain objects and arrays included) cannot be changed, and `expiresAt` is a per-request copy. Before, the cache returned the same mutable object to every request with the same credential, so a handler that did `getAuthContext().roles.push("admin")` granted that role to later requests presenting the same token. A handler that mutates the identity now gets a `TypeError` (modules are strict mode) and must copy what it wants to change. Without `cache` nothing changes: the object returned by the verifier is passed through.

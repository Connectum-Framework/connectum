---
"@connectum/auth": minor
---

fix(security): `createJwtAuthInterceptor` now rejects a token whose subject is not a non-empty string with `Unauthenticated: JWT missing subject claim`. Before, a `sub` that was an empty string, a number, a boolean, an array or an object was accepted, so a handler saw `subject: ""` or `subject: 123`, and with `propagateHeaders: true` a numeric `sub` ended the call with `internal`. The same check applies to a subject read through `claimsMapping.subject`.

**BREAKING** for an identity provider that issues tokens with an empty or numeric `sub`: issue a string subject, or map another claim with `claimsMapping.subject`. See the migration guide `auth-authorization-validation`.

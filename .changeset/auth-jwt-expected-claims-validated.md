---
"@connectum/auth": minor
---

fix(security): `createJwtAuthInterceptor` no longer switches a check off when its option is falsy. An empty `issuer` or `audience` (or an array with an empty entry) used to skip the check, so a token from any issuer for any audience was accepted, typically after `issuer: process.env.ISSUER ?? ""`; the interceptor now throws a `TypeError` that names the option. `maxTokenAge: 0`, a negative or non-finite number and a blank string used to skip the age check too; they now throw a `RangeError`. An omitted option still means "do not check", and an empty array still matches no token.

**BREAKING** for a configuration that passed an empty value to skip a check: omit the option instead. See the migration guide `auth-authorization-validation`.

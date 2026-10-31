---
"@connectum/auth": minor
---

fix(security): `createJwtAuthInterceptor` no longer switches a check off when its option is falsy. An empty `issuer` or `audience` string used to skip the check, so a token from any issuer for any audience was accepted, typically after `issuer: process.env.ISSUER ?? ""`; the interceptor now throws a `TypeError` that names the option. `maxTokenAge: 0`, `NaN` and an empty string used to skip the age check too; they now throw a `RangeError`. Values that were truthy and unusable were passed to jose and never matched or always failed (an array with an empty entry, a negative or infinite number, a whitespace-only string, a duration text jose cannot read such as `"1month"`); these throw at creation as well, instead of rejecting tokens at request time. An omitted option still means "do not check", and an empty array still matches no token. The per-issuer `audience` and `maxTokenAge` of `signedTokenTrust` follow the same rules.

**BREAKING** for a configuration that passed an empty value to skip a check: omit the option instead. See the migration guide `auth-authorization-validation`.

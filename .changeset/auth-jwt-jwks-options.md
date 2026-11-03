---
"@connectum/auth": minor
---

feat: `createJwtAuthInterceptor` takes a `jwks` option, `{ cooldownDuration, cacheMaxAge, timeoutDuration }` in milliseconds, that is passed to jose's `createRemoteJWKSet` for `jwksUri`. Without it nothing changes: jose's defaults stay (30 s cooldown, 10 min cache age, 5 s request timeout). Right after a key rotation a token signed with the new key is rejected with `Unauthenticated` until the cooldown has passed since the last fetch, and the retired key keeps verifying until the key set is fetched again (at the latest when the cache expires, earlier if a token with an unknown key arrives after the cooldown); `jwks: { cooldownDuration: 0 }` fetches the key set at once for an unknown key, and `cacheMaxAge` is an upper bound on how long a retired key is accepted. A key set that cannot be fetched still ends the call with `Unauthenticated: Authentication failed`; `timeoutDuration` bounds the wait.

`jwks` is checked when the interceptor is created: it needs `jwksUri`, and an unknown name, a non-number or a value out of range throws a `TypeError` or `RangeError` that names the option.

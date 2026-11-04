---
"@connectum/auth": minor
---

fix(security): `createAuthzInterceptor` and `createProtoAuthzInterceptor` now throw a `TypeError` when they are created with a `defaultPolicy` or a rule `effect` that is not exactly `"allow"` or `"deny"`, naming the option and the value. Before, any other value (`"Deny"`, `"DENY"`, `"dney"`, `""`, `null`) was read as "allow", so a typo in a configuration file or environment variable opened every method that no rule matched, and a deny rule with `effect: "DENY"` allowed. An omitted `defaultPolicy` is still `"deny"`. At request time the interceptors also treat anything other than the exact `"allow"` as a denial, for a rule whose `effect` was changed after creation.

**BREAKING** for configurations that relied on a misspelled value: the process now fails at startup. Fix the spelling (the values are lowercase `allow` and `deny`) or remove the option to get the default `deny`. See the migration guide `auth-authorization-validation`.

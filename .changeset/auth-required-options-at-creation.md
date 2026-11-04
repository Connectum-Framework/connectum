---
"@connectum/auth": minor
---

fix(auth): `createGatewayAuthInterceptor`, `createInternalAuthInterceptor` and `createAuthInterceptor` now check the options they cannot work without when they are created, and the error names the factory and the option. Before, `expectedValues: [process.env.GATEWAY_SECRET]` with the variable unset, a missing `internalMethods` or a missing `verifyCredentials` produced an interceptor that failed every request with a bare `internal` or `Authentication failed`, and a missing `trustSource` threw an unlabelled `TypeError`. A bad `expectedValues` entry is reported by index and kind only, never by value, because it may be a secret.

**BREAKING** for code that created these interceptors with unusable options. Most of them rejected every call already. One configuration used to work in part: an `expectedValues` list that holds a valid secret next to an `undefined` or empty entry (`[process.env.GATEWAY_SECRET, process.env.OLD_SECRET]` with the second variable unset) admitted a request that carried the valid secret, and failed with `internal` on any other value. Creation now throws for such a list, so the process stops at startup. Fix the option (drop the unset entry), or do not register the interceptor. See the migration guide `auth-authorization-validation`.

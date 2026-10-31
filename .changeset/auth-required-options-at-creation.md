---
"@connectum/auth": minor
---

fix(auth): `createGatewayAuthInterceptor`, `createInternalAuthInterceptor` and `createAuthInterceptor` now check the options they cannot work without when they are created, and the error names the factory and the option. Before, `expectedValues: [process.env.GATEWAY_SECRET]` with the variable unset, a missing `internalMethods` or a missing `verifyCredentials` produced an interceptor that failed every request with a bare `internal` or `Authentication failed`, and a missing `trustSource` threw an unlabelled `TypeError`. A bad `expectedValues` entry is reported by index and kind only, never by value, because it may be a secret.

**BREAKING** only for code that created these interceptors with unusable options (they rejected every call already): fix the option, or do not register the interceptor. See the migration guide `auth-authorization-validation`.

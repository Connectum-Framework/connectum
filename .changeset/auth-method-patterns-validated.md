---
"@connectum/auth": minor
---

fix(security): `@connectum/auth` now refuses a method pattern it cannot match when an interceptor is created. Only `"*"`, `"Service/*"` and `"Service/Method"` match anything; a partial wildcard (`"Service/Write*"`, `"acme.v1.*/*"`), a bare service name or a leading slash was accepted and silently never matched, so a `deny` rule written that way did nothing and a `skipMethods` entry skipped nothing. `createAuthInterceptor`, `createJwtAuthInterceptor`, `createSessionAuthInterceptor`, `createGatewayAuthInterceptor` and `createAuthzInterceptor` check `skipMethods`, `createAuthzInterceptor` and `createProtoAuthzInterceptor` check the `methods` of every rule, and `createInternalAuthInterceptor` checks `internalMethods`. The error is a `TypeError` that names the option (and the rule) and the pattern.

**BREAKING** for a configuration that carried such a pattern: replace it with exact methods or a complete `Service/*` pattern. See the migration guide `auth-authorization-validation`.

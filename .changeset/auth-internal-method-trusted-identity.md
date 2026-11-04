---
"@connectum/auth": minor
---

fix(security): `createProtoAuthzInterceptor` now admits an `internal` method that has no `requires` only for an identity established by `createInternalAuthInterceptor`. Before, any `AuthContext` was enough, so an end-user JWT reached the method when `createInternalAuthInterceptor` was missing from the chain, was given `internalMethods: []`, or did not list the method. Any other identity now ends the call with `Unauthenticated: Untrusted internal request`. The documented chain (the JWT interceptor skips internal methods, the internal interceptor runs before proto authz) is unchanged. An `internal` method with `requires` keeps checking roles and scopes as before.

**BREAKING** for a chain that fed `internal` methods from another interceptor (a custom one, the gateway interceptor, the session interceptor): authenticate those callers with `createInternalAuthInterceptor` and a trust source, as the proto authorization guide describes. See the migration guide `auth-authorization-validation`.

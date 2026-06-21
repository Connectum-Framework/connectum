# @connectum/auth

Authentication and authorization interceptors for Connectum.

**@connectum/auth** provides pluggable authentication, JWT verification, and declarative authorization for ConnectRPC services. Auth context propagates automatically via `AsyncLocalStorage` -- no manual parameter threading required.

## Features

- **Generic auth interceptor** -- bring your own credential extractor and verifier (API keys, mTLS, custom tokens)
- **JWT auth interceptor** -- built-in JWT verification via [jose](https://github.com/panva/jose) with JWKS, HMAC, and asymmetric key support
- **Gateway auth interceptor** -- extract pre-authenticated identity from API gateway headers (Kong, Envoy, etc.) with header-based trust verification
- **Session auth interceptor** -- session-based authentication for frameworks like better-auth, lucia, etc.
- **Authorization interceptor** -- declarative RBAC rules with first-match semantics and programmatic fallback
- **Proto authorization interceptor** -- authorization driven by `connectum.auth.v1` proto custom options, with `getPublicMethods`/`resolveMethodAuth` reader utilities
- **Client Bearer interceptor** -- client-side `Authorization: Bearer <token>` injection with static tokens or async refresh factories
- **Client gateway interceptor** -- client-side service-to-service auth headers (gateway secret + subject + roles) for calls behind an API gateway
- **Internal (service-to-service) auth interceptor** -- authorize proto-`internal` methods via a pluggable per-service trust source (mesh identity, per-service signed tokens, or a dev-only shared secret)
- **AsyncLocalStorage context** -- zero-boilerplate access to auth context from any handler
- **Header propagation** -- cross-service auth context forwarding (Envoy-style `x-auth-*` headers)
- **LRU cache** -- in-memory credential verification caching with TTL expiration
- **Testing utilities** -- mock contexts, test JWTs, and context injection helpers via `@connectum/auth/testing`

## Installation

```bash
pnpm add @connectum/auth
```

## Quick Start

```typescript
import { createServer } from '@connectum/core';
import { createDefaultInterceptors } from '@connectum/interceptors';
import { createJwtAuthInterceptor } from '@connectum/auth';
import routes from '#gen/routes.js';

const jwtAuth = createJwtAuthInterceptor({
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com/',
  audience: 'my-api',
});

const server = createServer({
  services: [routes],
  port: 5000,
  interceptors: [
    ...createDefaultInterceptors(),
    jwtAuth,
  ],
});

await server.start();
```

Access the authenticated user in any handler:

```typescript
import { requireAuthContext } from '@connectum/auth';

const handler = {
  async getProfile() {
    const auth = requireAuthContext(); // throws Unauthenticated if missing
    return { userId: auth.subject, roles: auth.roles };
  },
};
```

## API Reference

### createAuthInterceptor(options)

Generic authentication interceptor. Extracts credentials from the request, verifies them via a user-provided callback, and stores the resulting `AuthContext` in `AsyncLocalStorage`.

```typescript
import { createAuthInterceptor } from '@connectum/auth';

const auth = createAuthInterceptor({
  extractCredentials: (req) => req.header.get('x-api-key'),
  verifyCredentials: async (apiKey) => {
    const user = await db.findByApiKey(apiKey);
    if (!user) throw new Error('Invalid API key');
    return {
      subject: user.id,
      roles: user.roles,
      scopes: [],
      claims: {},
      type: 'api-key',
    };
  },
  skipMethods: ['grpc.health.v1.Health/*'],
});
```

**Options (`AuthInterceptorOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `verifyCredentials` | `(credentials: string) => AuthContext \| Promise<AuthContext>` | **required** | Verify credentials, return context. Must throw on failure. |
| `extractCredentials` | `(req: { header: Headers }) => string \| null \| Promise<string \| null>` | Bearer token from `Authorization` header | Extract credential string from request |
| `skipMethods` | `string[]` | `[]` | Methods to skip (`"Service/Method"` or `"Service/*"`) |
| `propagateHeaders` | `boolean` | `false` | Set `x-auth-*` headers for downstream services |
| `cache` | `CacheOptions` | - | LRU cache for credentials verification results. Caches AuthContext by credential string. |
| `propagatedClaims` | `string[]` | - | Filter which claim keys are propagated in `x-auth-claims` header (SEC-001). When not set, all claims are propagated. |

### createJwtAuthInterceptor(options)

Convenience wrapper for JWT-based authentication. Handles token extraction from `Authorization: Bearer <token>`, verification via [jose](https://github.com/panva/jose), and standard claim mapping.

Key resolution priority: `jwksUri` > `publicKey` > `secret`.

A missing `sub` claim (and no `claimsMapping.subject` override) throws `ConnectError(Unauthenticated)` with message `"JWT missing subject claim"` (SEC-002).

```typescript
import { createJwtAuthInterceptor } from '@connectum/auth';

const jwtAuth = createJwtAuthInterceptor({
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com/',
  audience: 'my-api',
  claimsMapping: {
    roles: 'realm_access.roles',  // dot-notation for nested claims
    scopes: 'scope',
  },
  skipMethods: ['grpc.health.v1.Health/*'],
});
```

**Options (`JwtAuthInterceptorOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `jwksUri` | `string` | - | JWKS endpoint URL for remote key set |
| `secret` | `string` | - | HMAC symmetric secret (HS256/HS384/HS512) |
| `publicKey` | `CryptoKey` | - | Asymmetric public key (RSA, RSA-PSS, EC, EdDSA). Import via `crypto.subtle.importKey()`. |
| `issuer` | `string \| string[]` | - | Expected issuer(s) |
| `audience` | `string \| string[]` | - | Expected audience(s) |
| `algorithms` | `string[]` | - | Allowed algorithms |
| `maxTokenAge` | `number \| string` | - | Maximum token age. Number (seconds) or string (e.g., `"2h"`, `"7d"`). Passed to jose `jwtVerify`. |
| `claimsMapping` | `{ subject?, name?, roles?, scopes? }` | `{}` | Map JWT claims to AuthContext (supports dot-notation) |
| `skipMethods` | `string[]` | `[]` | Methods to skip |
| `propagateHeaders` | `boolean` | `false` | Propagate auth context as headers |

At least one of `jwksUri`, `secret`, or `publicKey` is required.

### createGatewayAuthInterceptor(options)

Authentication interceptor for services behind an API gateway (Kong, Envoy, AWS ALB, etc.) that has already performed authentication. Extracts auth context from gateway-injected headers after verifying trust.

Trust is established via a designated header (e.g., `x-gateway-secret`) rather than peer address, since ConnectRPC interceptors do not have access to peer info.

Gateway headers are **always** stripped from requests -- including skipped methods -- to prevent downstream spoofing.

```typescript
import { createGatewayAuthInterceptor } from '@connectum/auth';

const gatewayAuth = createGatewayAuthInterceptor({
  headerMapping: {
    subject: 'x-user-id',
    name: 'x-user-name',
    roles: 'x-user-roles',
    scopes: 'x-user-scopes',
  },
  trustSource: {
    header: 'x-gateway-secret',
    expectedValues: [process.env.GATEWAY_SECRET],
  },
  skipMethods: ['grpc.health.v1.Health/*'],
});
```

**Options (`GatewayAuthInterceptorOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `headerMapping` | `GatewayHeaderMapping` | **required** | Mapping from AuthContext fields to gateway header names |
| `trustSource` | `{ header: string; expectedValues: string[] }` | **required** | Trust verification: header name and accepted values (shared secrets or trusted IP ranges via CIDR) |
| `stripHeaders` | `string[]` | `[]` | Additional headers to strip from request after extraction |
| `skipMethods` | `string[]` | `[]` | Methods to skip authentication for (headers are still stripped) |
| `propagateHeaders` | `boolean` | `false` | Propagate auth context as `x-auth-*` headers for downstream services |
| `defaultType` | `string` | `"gateway"` | Default credential type when not provided by gateway |

**`GatewayHeaderMapping`**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subject` | `string` | Yes | Header containing the authenticated subject |
| `name` | `string` | No | Header containing the display name |
| `roles` | `string` | No | Header containing JSON-encoded roles array (falls back to comma-separated parsing) |
| `scopes` | `string` | No | Header containing space-separated scopes |
| `type` | `string` | No | Header containing credential type |
| `claims` | `string` | No | Header containing JSON-encoded claims (ignored if >8192 bytes) |

Validation: `headerMapping.subject` must be non-empty, and `trustSource.expectedValues` must be non-empty. Both throw `Error` at construction time (fail-closed).

### createSessionAuthInterceptor(options)

Session-based authentication interceptor for frameworks like [better-auth](https://www.better-auth.com/) and lucia. Implements a two-step verification flow:

1. Extract token from request (default: `Authorization: Bearer <token>`)
2. Verify session via user-provided callback -- receives both the token **and** full request headers for cookie-based auth support
3. Map raw session data to `AuthContext` via user-provided mapper

```typescript
import { createSessionAuthInterceptor } from '@connectum/auth';
import { betterAuth } from 'better-auth';

const auth = betterAuth({ /* DB adapter config */ });

const sessionAuth = createSessionAuthInterceptor({
  verifySession: async (token, headers) => {
    const session = await auth.api.getSession({ headers });
    if (!session) throw new Error('Invalid session');
    return session;
  },
  mapSession: (session) => ({
    subject: session.user.id,
    name: session.user.name,
    roles: session.user.roles ?? [],
    scopes: [],
    claims: session.user,
    type: 'session',
  }),
  cache: { ttl: 60_000 },
});
```

**Options (`SessionAuthInterceptorOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `verifySession` | `(token: string, headers: Headers) => unknown \| Promise<unknown>` | **required** | Verify session token and return raw session data. Receives full request headers for cookie support. Must throw on failure. |
| `mapSession` | `(session: unknown) => AuthContext \| Promise<AuthContext>` | **required** | Map raw session data to `AuthContext`. |
| `extractToken` | `(req: { header: Headers }) => string \| null \| Promise<string \| null>` | Bearer token from `Authorization` header | Custom token extraction |
| `cache` | `CacheOptions` | - | LRU cache for session verification results |
| `skipMethods` | `string[]` | `[]` | Methods to skip authentication for |
| `propagateHeaders` | `boolean` | `false` | Propagate auth context as `x-auth-*` headers for downstream services |
| `propagatedClaims` | `string[]` | - | Filter which claim keys are propagated in `x-auth-claims` header. When not set, all claims are propagated. |

### createInternalAuthInterceptor(options)

> Available since 1.1.0.

Internal (service-to-service) authentication interceptor (ADR-029). For methods marked `internal` in proto options, it authorizes the call from a configurable per-service **trust source** instead of an end-user token, and rejects a missing/invalid marker as `Code.Unauthenticated`. Non-internal methods are a **no-op pass-through**.

Internal methods skip end-user (JWT) authentication, so feed `getInternalMethods(services)` into the JWT interceptor's `skipMethods` (alongside `getPublicMethods(services)`); this interceptor then enforces the internal trust marker on those same methods.

```typescript
import {
  createInternalAuthInterceptor,
  meshIdentityTrust,
  createJwtAuthInterceptor,
  getInternalMethods,
  getPublicMethods,
} from '@connectum/auth';
import services from '#gen/services.js';

// JWT skips both public and internal methods; the internal interceptor
// then enforces the trust marker on the internal ones.
const jwtAuth = createJwtAuthInterceptor({
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  skipMethods: [...getPublicMethods(services), ...getInternalMethods(services)],
});

const internalAuth = createInternalAuthInterceptor({
  internalMethods: getInternalMethods(services),
  trustSource: meshIdentityTrust({
    allowlist: [
      { principal: 'cluster.local/ns/default/sa/trips', roles: ['worker'] },
    ],
  }),
});
```

**Options (`InternalAuthInterceptorOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `trustSource` | `InternalTrustSource` | **required** | Pluggable trust source that authorizes an internal call -- use `meshIdentityTrust`, `signedTokenTrust`, `sharedSecretTrust`, or a custom function. Returning `null` (or throwing) rejects the call as `Unauthenticated`. |
| `internalMethods` | `readonly string[]` | **required** | Method patterns enforced as internal (`"Service/Method"`, `"Service/*"`, or `"*"`). Typically `getInternalMethods(services)`. All other methods pass through unchanged. |

**Chain order (load-bearing).** This interceptor MUST run **before** `createProtoAuthzInterceptor`: it populates the `AuthContext` that proto-authz's `internal` rule consumes.

```text
errorHandler -> (jwtAuth | internalAuth) -> protoAuthz
```

For an `internal` method, `createProtoAuthzInterceptor` composes the marker inclusively with the existing roles/scopes model:

- `internal` + no identity (no `AuthContext`) -> `Unauthenticated`
- `internal` + no `requires` -> allow (any trusted internal caller)
- `internal` + `requires { roles | scopes }` -> the existing roles/scopes check against the same `AuthContext`

> **Proto contract (additive).** `optional bool internal` was added to both `ServiceAuth` and `MethodAuth` in `connectum.auth.v1`. Marking a method `internal` instead of `public` removes world-open exposure while keeping it reachable by trusted callers (ADR-029).

`InternalTrustSource` is `(req: { header: Headers }) => AuthContext | null | Promise<AuthContext | null>`. Each shipped trust source strips its own trust header after extraction on the internal path (accept and reject) to prevent a spoofed marker from being propagated downstream.

### meshIdentityTrust(options)

> Available since 1.1.0.

Production-default trust source. Verifies a mesh-forwarded peer principal (an Istio short-form ServiceAccount principal `cluster.local/ns/<ns>/sa/<name>`, or a SPIFFE id) against an allow-list. Because the mesh issues each workload its own mTLS identity, matching the forwarded principal against the allow-list is **per-service by construction** -- compromising one workload cannot forge another's identity. The identity header is stripped after extraction (anti-spoofing).

```typescript
import { createInternalAuthInterceptor, meshIdentityTrust, getInternalMethods } from '@connectum/auth';
import services from '#gen/services.js';

const internalAuth = createInternalAuthInterceptor({
  internalMethods: getInternalMethods(services),
  trustSource: meshIdentityTrust({
    allowlist: [
      { principal: 'cluster.local/ns/default/sa/trips', roles: ['worker'], name: 'trips-service' },
      { principal: 'cluster.local/ns/default/sa/billing', scopes: ['charge'] },
    ],
  }),
});
```

**Options (`MeshIdentityTrustOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowlist` | `readonly MeshIdentityEntry[]` | **required** | Permitted mesh identities. A non-empty list is enforced at construction (throws otherwise). A request whose principal is not on the list is rejected. |
| `header` | `string` | `"x-forwarded-client-principal"` | Header carrying the mesh-forwarded peer identity |
| `type` | `string` | `"mesh"` | Credential type set on the resulting `AuthContext` |

**`MeshIdentityEntry`**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `principal` | `string` | Yes | Forwarded peer identity to match (Istio ServiceAccount principal or SPIFFE id) |
| `roles` | `readonly string[]` | No | Roles granted to this caller (compose via `requires { roles }`) |
| `scopes` | `readonly string[]` | No | Scopes granted to this caller (compose via `requires { scopes }`) |
| `name` | `string` | No | Human-readable name for the calling service |

### signedTokenTrust(options)

> Available since 1.1.0.

Non-mesh, per-service trust source. Each caller signs a short-lived JWT with its **own** private key; this trust source verifies it against that service's published JWKS, so compromising service A's key forges only A.

**Issuer-bound key selection (hard security requirement).** The keyset is selected by the token's claimed `iss` (`issuers[iss].jwksUri`), and verification is **pinned** to that same issuer -- each issuer gets its own `createRemoteJWKSet`, so no verification call ever receives a keyset spanning more than one issuer. A token claiming `iss: "B"` but signed with A's key is **rejected**. (A single shared JWKS holding multiple services' keys does NOT contain compromise, because `jose` resolves the signing key by `kid` independently of `iss`.)

The framework ships only the verification primitive; key issuance/rotation/JWKS publication belong to the deployment (SPIRE / the IdP / the mesh).

```typescript
import { createInternalAuthInterceptor, signedTokenTrust, getInternalMethods } from '@connectum/auth';
import services from '#gen/services.js';

const internalAuth = createInternalAuthInterceptor({
  internalMethods: getInternalMethods(services),
  trustSource: signedTokenTrust({
    issuers: {
      'trips-service': {
        jwksUri: 'https://trips/.well-known/jwks.json',
        claimsMapping: { roles: 'roles' },
      },
      'billing-service': { jwksUri: 'https://billing/.well-known/jwks.json' },
    },
  }),
});
```

**Options (`SignedTokenTrustOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `issuers` | `Readonly<Record<string, SignedTokenIssuer>>` | **required** | Per-issuer JWKS config keyed by the token's `iss` value. At least one issuer is enforced at construction (throws otherwise). |
| `header` | `string` | `"x-internal-token"` | Header carrying the service token (bare token or `Bearer <token>`) |
| `type` | `string` | `"service"` | Credential type set on the resulting `AuthContext` |

**`SignedTokenIssuer`**:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `jwksUri` | `string` | **required** | The issuer's JWKS endpoint URL (its own keyset only) |
| `audience` | `string \| string[]` | - | Expected audience(s) for tokens from this issuer |
| `algorithms` | `string[]` | `["RS256"]` | Allowed signing algorithms |
| `maxTokenAge` | `number \| string` | - | Maximum token age (seconds or string like `"2h"`) |
| `claimsMapping` | `{ subject?, name?, roles?, scopes? }` | `{}` | Map token claims to `AuthContext` (dot-notation). Subject defaults to the `sub` claim, else the issuer. |

### sharedSecretTrust(options)

> Available since 1.1.0.

> **DEV-ONLY.** A single shared secret is **not** per-service: every legitimate caller holds the same secret, so one compromise forges **all** internal identities. Use `meshIdentityTrust` (mesh) or `signedTokenTrust` (non-mesh per-service JWT) in production. This factory exists only for local development and single-tenant low-trust-boundary setups.

Constant-time compares a single shared secret against the trust header. The header is stripped after extraction (anti-spoofing).

```typescript
import { createInternalAuthInterceptor, sharedSecretTrust, getInternalMethods } from '@connectum/auth';
import services from '#gen/services.js';

const internalAuth = createInternalAuthInterceptor({
  internalMethods: getInternalMethods(services),
  trustSource: sharedSecretTrust({
    secret: process.env.INTERNAL_SECRET ?? '',
    subject: 'internal-batch',
    roles: ['worker'],
  }),
});
```

**Options (`SharedSecretTrustOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secret` | `string` | **required** | Shared secret, constant-time compared against the header value. A non-empty secret is enforced at construction (throws otherwise). |
| `header` | `string` | `"x-internal-secret"` | Header carrying the shared secret |
| `subject` | `string` | `"internal"` | Subject identity assigned to a trusted call |
| `roles` | `readonly string[]` | `[]` | Roles granted to a trusted caller |
| `scopes` | `readonly string[]` | `[]` | Scopes granted to a trusted caller |
| `type` | `string` | `"internal"` | Credential type set on the resulting `AuthContext` |

### createAuthzInterceptor(options)

Declarative rules-based authorization. Evaluates rules in order; first matching rule wins. Must run **after** an authentication interceptor.

```typescript
import { createAuthzInterceptor } from '@connectum/auth';

const authz = createAuthzInterceptor({
  defaultPolicy: 'deny',
  rules: [
    {
      name: 'health-public',
      methods: ['grpc.health.v1.Health/*'],
      effect: 'allow',
    },
    {
      name: 'admin-only',
      methods: ['admin.v1.AdminService/*'],
      effect: 'allow',
      requires: { roles: ['admin'] },
    },
    {
      name: 'users-read',
      methods: ['user.v1.UserService/GetUser', 'user.v1.UserService/ListUsers'],
      effect: 'allow',
      requires: { scopes: ['read'] },
    },
  ],
});
```

**Options (`AuthzInterceptorOptions`)**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultPolicy` | `'allow' \| 'deny'` | `'deny'` | Policy when no rule matches |
| `rules` | `AuthzRule[]` | `[]` | Declarative rules (first match wins) |
| `authorize` | `(context, req) => boolean \| Promise<boolean>` | - | Programmatic fallback after rules |
| `skipMethods` | `string[]` | `[]` | Methods to skip authorization |

**AuthzRule**:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Rule name (used in error messages) |
| `methods` | `string[]` | Method patterns: `"*"`, `"Service/*"`, `"Service/Method"` |
| `effect` | `'allow' \| 'deny'` | Effect when rule matches |
| `requires` | `{ roles?: string[], scopes?: string[] }` | Required roles (any-of) and/or scopes (all-of) |

### getAuthContext() / requireAuthContext()

Access the authenticated user context set by an auth interceptor.

```typescript
import { getAuthContext, requireAuthContext } from '@connectum/auth';

// Returns AuthContext | undefined
const auth = getAuthContext();

// Returns AuthContext, throws ConnectError(Unauthenticated) if missing
const auth = requireAuthContext();
```

**AuthContext**:

| Field | Type | Description |
|-------|------|-------------|
| `subject` | `string` | User/service identifier |
| `name` | `string?` | Display name |
| `roles` | `readonly string[]` | Assigned roles |
| `scopes` | `readonly string[]` | Granted scopes |
| `claims` | `Record<string, unknown>` | Raw credential claims |
| `type` | `string` | Credential type (`"jwt"`, `"api-key"`, etc.) |
| `expiresAt` | `Date?` | Credential expiration |

### LruCache

Minimal in-memory LRU cache with TTL expiration. Uses `Map` insertion order for LRU eviction. Used by `createAuthInterceptor` and `createSessionAuthInterceptor` for caching verification results.

```typescript
import { LruCache } from '@connectum/auth';

const cache = new LruCache<{ userId: string }>({
  ttl: 60_000,     // 60 seconds
  maxSize: 500,    // default: 1000
});

cache.set('key', { userId: 'user-1' });
const value = cache.get('key'); // { userId: 'user-1' } or undefined (expired/missing)
cache.clear();
cache.size; // 0
```

**Constructor**: `new LruCache<T>(options: { ttl: number; maxSize?: number })`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ttl` | `number` | **required** | Cache entry time-to-live in milliseconds. Must be positive (throws `RangeError`). |
| `maxSize` | `number` | `1000` | Maximum number of cached entries |

**Methods**:

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `(key: string) => T \| undefined` | Get cached value. Returns `undefined` if missing or expired. Moves entry to most-recently-used. |
| `set` | `(key: string, value: T) => void` | Set a value. Evicts LRU entry if at capacity. |
| `clear` | `() => void` | Remove all entries |
| `size` | `number` (getter) | Current number of entries |

**`CacheOptions`** (used by `AuthInterceptorOptions.cache` and `SessionAuthInterceptorOptions.cache`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ttl` | `number` | **required** | Cache entry time-to-live in milliseconds |
| `maxSize` | `number` | - | Maximum number of cached entries |

### parseAuthHeaders(headers) / setAuthHeaders(headers, context, propagatedClaims?)

Serialize and deserialize `AuthContext` to/from HTTP headers for cross-service propagation.

```typescript
import { parseAuthHeaders, setAuthHeaders } from '@connectum/auth';

// Read context from upstream headers (trusted environments only)
const context = parseAuthHeaders(req.header);

// Write context to outgoing headers
setAuthHeaders(outgoingHeaders, authContext);

// Write context with filtered claims (only propagate listed keys)
setAuthHeaders(outgoingHeaders, authContext, ['email', 'tenant_id']);
```

`setAuthHeaders` silently drops roles, scopes, or claims values that exceed 8192 bytes to prevent header size abuse.

### AUTH_HEADERS

Standard header names for auth context propagation:

| Constant | Value | Content |
|----------|-------|---------|
| `AUTH_HEADERS.SUBJECT` | `x-auth-subject` | Subject identifier |
| `AUTH_HEADERS.NAME` | `x-auth-name` | Display name |
| `AUTH_HEADERS.ROLES` | `x-auth-roles` | JSON-encoded roles array |
| `AUTH_HEADERS.SCOPES` | `x-auth-scopes` | Space-separated scopes |
| `AUTH_HEADERS.CLAIMS` | `x-auth-claims` | JSON-encoded claims object |
| `AUTH_HEADERS.TYPE` | `x-auth-type` | Credential type |

### AuthzEffect

Authorization rule effect constants:

```typescript
import { AuthzEffect } from '@connectum/auth';

AuthzEffect.ALLOW  // 'allow'
AuthzEffect.DENY   // 'deny'
```

## Interceptor Chain Order

Auth interceptors should be placed **after** the default interceptor chain (error handler and validation by default, plus any resilience interceptors you explicitly enable) and **before** business logic:

```text
errorHandler -> [timeout -> bulkhead -> circuitBreaker -> retry, opt-in] -> validation -> auth -> authz -> handler
```

```typescript
import { createServer } from '@connectum/core';
import { createDefaultInterceptors } from '@connectum/interceptors';
import { createJwtAuthInterceptor, createAuthzInterceptor } from '@connectum/auth';

const server = createServer({
  services: [routes],
  interceptors: [
    ...createDefaultInterceptors(),
    createJwtAuthInterceptor({ secret: process.env.JWT_SECRET }),
    createAuthzInterceptor({ defaultPolicy: 'deny', rules: [...] }),
  ],
});
```

## Testing

The `@connectum/auth/testing` sub-export provides utilities for testing authenticated handlers and services.

```bash
# Imported separately from the main package
import { ... } from '@connectum/auth/testing';
```

### createMockAuthContext(overrides?)

Create an `AuthContext` with sensible defaults. Overrides are shallow-merged.

```typescript
import { createMockAuthContext } from '@connectum/auth/testing';

const ctx = createMockAuthContext();
// { subject: 'test-user', name: 'Test User', roles: ['user'], scopes: ['read'], claims: {}, type: 'test' }

const admin = createMockAuthContext({ subject: 'admin-1', roles: ['admin'] });
```

### createTestJwt(payload, options?)

Create a signed HS256 JWT for integration tests. Uses a deterministic test secret.

```typescript
import { createTestJwt, TEST_JWT_SECRET } from '@connectum/auth/testing';
import { createJwtAuthInterceptor } from '@connectum/auth';

const token = await createTestJwt(
  { sub: 'user-123', roles: ['admin'], scope: 'read write' },
  { expiresIn: '1h', issuer: 'test' },
);

// Wire up the interceptor with the test secret
const auth = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, issuer: 'test' });
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `expiresIn` | `string` | `'1h'` | Expiration (jose duration format) |
| `issuer` | `string` | - | Token issuer |
| `audience` | `string` | - | Token audience |

### withAuthContext(context, fn)

Run a function with a pre-set `AuthContext` in `AsyncLocalStorage`. Use this to test handlers that call `getAuthContext()` or `requireAuthContext()`.

```typescript
import { withAuthContext, createMockAuthContext } from '@connectum/auth/testing';
import { requireAuthContext } from '@connectum/auth';

await withAuthContext(createMockAuthContext({ subject: 'user-1' }), async () => {
  const auth = requireAuthContext();
  assert.strictEqual(auth.subject, 'user-1');
});
```

### TEST_JWT_SECRET

Deterministic HMAC secret for test JWTs: `"connectum-test-secret-do-not-use-in-production"`.

### generateRsaTestKeypair(kid?)

> Available since 1.1.0.

Generate an RSA (RS256) test keypair plus the matching public JWK for the production-realistic JWKS path (`createJwtAuthInterceptor({ jwksUri })`). Unlike `createTestJwt` (HS256-only), this exercises the asymmetric `jose.createRemoteJWKSet` branch. The returned `publicJwk` carries the `kid`/`alg`/`use` a JWKS endpoint publishes, and the same `kid` must be stamped on every token minted for it (otherwise key selection fails). Defaults the `kid` to `TEST_JWT_KID`.

```typescript
import { generateRsaTestKeypair } from '@connectum/auth/testing';

const keypair = await generateRsaTestKeypair();
// { privateKey, publicKey, publicJwk, kid }
```

**Returns (`RsaTestKeypair`)**:

| Field | Type | Description |
|-------|------|-------------|
| `privateKey` | `CryptoKey` | Private signing key -- pass to `createTestJwtRS256` |
| `publicKey` | `CryptoKey` | Public verification key |
| `publicJwk` | `jose.JWK` | Public JWK (`kid`, `alg: "RS256"`, `use: "sig"`) -- serve at the JWKS endpoint |
| `kid` | `string` | Key id shared by `publicJwk` and the token header |

### startTestJwksServer(jwks)

> Available since 1.1.0.

Start an ephemeral in-process JWKS server publishing the given public JWK(s) at `/.well-known/jwks.json` on a random loopback port. Pass `server.url` as `jwksUri` to `createJwtAuthInterceptor`. Call `close()` after the test.

```typescript
import { generateRsaTestKeypair, startTestJwksServer } from '@connectum/auth/testing';
import { createJwtAuthInterceptor } from '@connectum/auth';

const keypair = await generateRsaTestKeypair();
const jwks = await startTestJwksServer(keypair.publicJwk); // or an array of JWKs

const auth = createJwtAuthInterceptor({
  jwksUri: jwks.url,
  issuer: 'https://issuer.example',
  audience: 'my-api',
  algorithms: ['RS256'],
});

// ...exercise the interceptor...
await jwks.close();
```

**Returns (`TestJwksServer`)**:

| Member | Type | Description |
|--------|------|-------------|
| `url` | `string` | The JWKS URL -- pass as `jwksUri` to `createJwtAuthInterceptor` |
| `origin` | `string` | Origin without path, e.g. `http://127.0.0.1:<port>` |
| `close` | `() => Promise<void>` | Stop the server (e.g. in `after`) |

### createTestJwtRS256(privateKey, payload, options)

> Available since 1.1.0.

Mint an RS256 test token signed by the private key from `generateRsaTestKeypair`, with a `kid` header matching the published JWK. Verified through the same `createRemoteJWKSet` branch production uses, so an RS256 round-trip test exercises the real `jwksUri` code path. The `options` argument and its `kid` field are **required** (the `kid` must match the published JWK). NOT for production use.

```typescript
import {
  generateRsaTestKeypair,
  startTestJwksServer,
  createTestJwtRS256,
} from '@connectum/auth/testing';

const keypair = await generateRsaTestKeypair();
const jwks = await startTestJwksServer(keypair.publicJwk);

const token = await createTestJwtRS256(
  keypair.privateKey,
  { sub: 'user-123', roles: ['admin'], scope: 'read write' },
  { kid: keypair.kid, issuer: 'https://issuer.example', audience: 'my-api' },
);

// ...use `Authorization: Bearer ${token}`...
await jwks.close();
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `privateKey` | `CryptoKey` | Private key from `generateRsaTestKeypair` |
| `payload` | `Record<string, unknown>` | JWT claims (e.g. `sub`, `roles`, `scope`) |
| `options` | `{ kid: string; issuer?: string; audience?: string; expiresIn?: string }` | **required**; `kid` is required and must match the published JWK |

**`options` fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `kid` | `string` | **required** | Key id header (must match the published JWK) |
| `issuer` | `string` | - | Token issuer |
| `audience` | `string` | - | Token audience |
| `expiresIn` | `string` | `'1h'` | Expiration (jose duration format) |

### TEST_JWT_KID

> Available since 1.1.0.

Default `kid` shared by `generateRsaTestKeypair` and the tokens minted for it: `"connectum-test-key"`.

## Integration with better-auth

[better-auth](https://www.better-auth.com/) is a modern authentication framework for TypeScript. It supports programmatic session verification and works directly with `createSessionAuthInterceptor`.

```typescript
import { betterAuth } from "better-auth";
import { createSessionAuthInterceptor } from '@connectum/auth';

const auth = betterAuth({ /* DB adapter config */ });

const betterAuthInterceptor = createSessionAuthInterceptor({
    verifySession: async (token, headers) => {
        const session = await auth.api.getSession({ headers });
        if (!session) throw new Error("Invalid session");
        return session;
    },
    mapSession: (session) => ({
        subject: session.user.id,
        name: session.user.name,
        roles: session.user.roles ?? [],
        scopes: [],
        claims: session.user,
        type: "better-auth",
    }),
    cache: { ttl: 60_000 },
});
```

## Security Considerations

- **Header stripping**: `createAuthInterceptor` and `createSessionAuthInterceptor` strip all `x-auth-*` headers from incoming requests to prevent external spoofing. `createGatewayAuthInterceptor` strips all mapped gateway headers unconditionally -- including on skipped methods.
- **Header size limits**: `setAuthHeaders` silently drops roles, scopes, or claims values exceeding 8192 bytes. Gateway interceptor also ignores claims headers exceeding 8192 bytes.
- **Fail-closed trust**: `createGatewayAuthInterceptor` requires a non-empty `expectedValues` list and a non-empty `subject` mapping at construction time. Missing or mismatched trust header results in `Unauthenticated`.
- **JWT subject enforcement** (SEC-002): `createJwtAuthInterceptor` throws `Unauthenticated` when the JWT has no `sub` claim and no `claimsMapping.subject` override.
- **Claims filtering** (SEC-001): Use `propagatedClaims` to limit which claim keys are included in propagated `x-auth-claims` headers, preventing accidental leakage of sensitive token data.
- **HMAC key validation**: `createJwtAuthInterceptor` enforces minimum HMAC key sizes per RFC 7518 (32/48/64 bytes for HS256/HS384/HS512).

## Exports Summary

### Main export (`@connectum/auth`)

**Interceptor factories**:
- `createAuthInterceptor` -- generic pluggable authentication
- `createJwtAuthInterceptor` -- JWT convenience with jose
- `createGatewayAuthInterceptor` -- gateway-injected headers
- `createSessionAuthInterceptor` -- session-based auth
- `createInternalAuthInterceptor` -- internal (service-to-service) auth via a pluggable trust source
- `createAuthzInterceptor` -- declarative rules-based authorization
- `createProtoAuthzInterceptor` -- proto-option-driven authorization (`connectum.auth.v1`)
- `createClientBearerInterceptor` -- client-side Bearer token injection
- `createClientGatewayInterceptor` -- client-side gateway service-to-service auth

**Internal trust sources** (for `createInternalAuthInterceptor`):
- `meshIdentityTrust` -- production default; verify a mesh-forwarded peer principal against an allow-list
- `signedTokenTrust` -- non-mesh per-service signed JWT with issuer-bound JWKS
- `sharedSecretTrust` -- dev-only single shared secret (not per-service)

**Context management**:
- `getAuthContext` -- get current AuthContext (or undefined)
- `requireAuthContext` -- get current AuthContext (or throw)
- `authContextStorage` -- raw AsyncLocalStorage instance

**Header utilities**:
- `parseAuthHeaders` -- deserialize AuthContext from headers
- `setAuthHeaders` -- serialize AuthContext to headers
- `AUTH_HEADERS` -- standard header name constants

**Cache**:
- `LruCache` -- in-memory LRU cache with TTL

**Authorization**:
- `AuthzEffect` -- rule effect constants (`ALLOW`, `DENY`)
- `AuthzDeniedError` -- authorization denied error class
- `matchesMethodPattern` -- method pattern matching utility
- `getPublicMethods` -- collect `skipMethods` patterns for proto-`public` methods from service descriptors
- `getInternalMethods` -- collect patterns for proto-`internal` methods (feed into both the JWT interceptor's `skipMethods` and `createInternalAuthInterceptor`)
- `resolveMethodAuth` -- resolve effective per-method auth config from proto options (cached)

**Types** (TypeScript only):
- `AuthContext`
- `AuthInterceptorOptions`
- `JwtAuthInterceptorOptions`
- `GatewayAuthInterceptorOptions`
- `GatewayHeaderMapping`
- `SessionAuthInterceptorOptions`
- `InternalAuthInterceptorOptions`
- `InternalTrustSource`
- `MeshIdentityTrustOptions`
- `MeshIdentityEntry`
- `SignedTokenTrustOptions`
- `SignedTokenIssuer`
- `SharedSecretTrustOptions`
- `AuthzInterceptorOptions`
- `ProtoAuthzInterceptorOptions`
- `ClientBearerInterceptorOptions`
- `ClientGatewayInterceptorOptions`
- `ResolvedMethodAuth`
- `AuthzRule`
- `CacheOptions`
- `InterceptorFactory`
- `AuthzDeniedDetails`

### Testing export (`@connectum/auth/testing`)

- `createMockAuthContext` -- create AuthContext with defaults
- `createTestJwt` -- create signed HS256 test JWT
- `createTestJwtRS256` -- mint an RS256 test JWT verified through the production JWKS branch
- `generateRsaTestKeypair` -- generate an RSA (RS256) test keypair + public JWK
- `startTestJwksServer` -- start an in-process JWKS server publishing the public JWK(s)
- `withAuthContext` -- run code with injected AuthContext
- `TEST_JWT_SECRET` -- deterministic HS256 test secret
- `TEST_JWT_KID` -- default `kid` for the RS256 helpers
- `RsaTestKeypair`, `TestJwksServer` -- types for the RS256 helpers (TypeScript only)

## Dependencies

- `@connectum/core` -- Connectum server foundation (runtime dependency)
- `@connectrpc/connect` -- ConnectRPC core (runtime dependency)
- `@bufbuild/protobuf` -- Protobuf runtime (runtime dependency)
- `jose` -- JWT/JWK/JWS verification

## Requirements

- **Node.js**: >=22.13.0
- **TypeScript**: >=5.7.2 (for type checking)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

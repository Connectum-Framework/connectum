# @connectum/auth

Authentication and authorization interceptors for Connectum.

**@connectum/auth** provides pluggable authentication, JWT verification, and declarative authorization for ConnectRPC services. Auth context propagates automatically via `AsyncLocalStorage` -- no manual parameter threading required.

## Features

- **Generic auth interceptor** -- bring your own credential extractor and verifier (API keys, mTLS, custom tokens)
- **JWT auth interceptor** -- built-in JWT verification via [jose](https://github.com/panva/jose) with JWKS, HMAC, and asymmetric key support
- **Authorization interceptor** -- declarative RBAC rules with first-match semantics and programmatic fallback
- **AsyncLocalStorage context** -- zero-boilerplate access to auth context from any handler
- **Header propagation** -- cross-service auth context forwarding (Envoy-style `x-auth-*` headers)
- **Trusted proxy reader** -- fail-closed header trust with IP/CIDR allowlisting
- **Testing utilities** -- mock contexts, test JWTs, and context injection helpers via `@connectum/auth/testing`

## Installation

```bash
pnpm add @connectum/auth
```

**Peer dependencies**:

```bash
pnpm add @connectrpc/connect
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
| `extractCredentials` | `(req) => string \| null \| Promise<string \| null>` | Bearer token from `Authorization` header | Extract credential string from request |
| `skipMethods` | `string[]` | `[]` | Methods to skip (`"Service/Method"` or `"Service/*"`) |
| `propagateHeaders` | `boolean` | `false` | Set `x-auth-*` headers for downstream services |

### createJwtAuthInterceptor(options)

Convenience wrapper for JWT-based authentication. Handles token extraction from `Authorization: Bearer <token>`, verification via [jose](https://github.com/panva/jose), and standard claim mapping.

Key resolution priority: `jwksUri` > `secret` > `publicKey`.

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
| `publicKey` | `CryptoKey` | - | Asymmetric public key |
| `issuer` | `string \| string[]` | - | Expected issuer(s) |
| `audience` | `string \| string[]` | - | Expected audience(s) |
| `algorithms` | `string[]` | - | Allowed algorithms |
| `claimsMapping` | `{ subject?, name?, roles?, scopes? }` | `{}` | Map JWT claims to AuthContext (supports dot-notation) |
| `skipMethods` | `string[]` | `[]` | Methods to skip |
| `propagateHeaders` | `boolean` | `false` | Propagate auth context as headers |

At least one of `jwksUri`, `secret`, or `publicKey` is required.

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

### parseAuthHeaders(headers) / setAuthHeaders(headers, context)

Serialize and deserialize `AuthContext` to/from HTTP headers for cross-service propagation.

```typescript
import { parseAuthHeaders, setAuthHeaders } from '@connectum/auth';

// Read context from upstream headers (trusted environments only)
const context = parseAuthHeaders(req.header);

// Write context to outgoing headers
setAuthHeaders(outgoingHeaders, authContext);
```

### createTrustedHeadersReader(options)

Read auth context from request headers only when the request comes from a trusted proxy. Fail-closed: returns `null` when the peer address doesn't match any trusted proxy.

```typescript
import { createTrustedHeadersReader } from '@connectum/auth';

const readTrusted = createTrustedHeadersReader({
  trustedProxies: ['10.0.0.0/8', '172.16.0.0/12'],
});

// Returns AuthContext | null
const context = readTrusted({ header: req.header, peerAddress: '10.0.1.5' });
```

**Options (`TrustedHeadersReaderOptions`)**:

| Option | Type | Description |
|--------|------|-------------|
| `trustedProxies` | `string[]` | **Required.** Trusted IP addresses or CIDR ranges. Empty array = never trust. |

### AUTH_HEADERS

Standard header names for auth context propagation:

| Constant | Value | Content |
|----------|-------|---------|
| `AUTH_HEADERS.SUBJECT` | `x-auth-subject` | Subject identifier |
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

Auth interceptors should be placed **after** the default interceptor chain (error handler, timeout, bulkhead, etc.) and **before** business logic:

```text
errorHandler -> timeout -> bulkhead -> circuitBreaker -> retry -> validation -> auth -> authz -> handler
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

## Integration with better-auth

[better-auth](https://www.better-auth.com/) is a modern authentication framework for TypeScript. It supports programmatic session verification and works directly with `createAuthInterceptor`.

```typescript
import { betterAuth } from "better-auth";
import { createAuthInterceptor } from '@connectum/auth';

const auth = betterAuth({ /* DB adapter config */ });

const betterAuthInterceptor = createAuthInterceptor({
    verifyCredentials: async (token) => {
        const session = await auth.api.getSession({
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!session) throw new Error("Invalid session");
        return {
            subject: session.user.id,
            roles: session.user.roles ?? [],
            scopes: [],
            claims: session.user,
            type: "better-auth",
        };
    },
});
```

## Dependencies

- `@connectrpc/connect` -- ConnectRPC core (peer dependency)
- `jose` -- JWT/JWK/JWS verification

## Requirements

- **Node.js**: >=18.0.0
- **TypeScript**: >=5.7.2 (for type checking)

## License

Apache-2.0

---

**Part of [@connectum](../../README.md)** -- Universal framework for production-ready gRPC/ConnectRPC microservices

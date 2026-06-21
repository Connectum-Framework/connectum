---
"@connectum/auth": minor
---

Add RS256 + JWKS test helpers to `@connectum/auth/testing`. The existing `createTestJwt` is HS256-only, but the production-realistic path with an external IdP is RS256 validated through a JWKS endpoint (`createJwtAuthInterceptor({ jwksUri })`). The new `generateRsaTestKeypair()`, `startTestJwksServer()`, and `createTestJwtRS256()` let you test that path without hand-rolling a keypair + JWKS server + minter — the minted token is verified through the same `createRemoteJWKSet` branch production uses.

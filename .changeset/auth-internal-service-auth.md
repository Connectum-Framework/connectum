---
"@connectum/auth": minor
---

Add a first-class `internal` (service-to-service) auth marker and interceptor (ADR-029), distinct from `public`. An `internal` method skips end-user (JWT) authentication but **requires an internal trust marker** — so promoting a method `public → internal` removes world-open exposure instead of merely renaming it, and the contract now audits as "internal" rather than "public".

- **Proto:** `optional bool internal` added to `ServiceAuth` and `MethodAuth` (`connectum/auth/v1/options.proto`, additive). `resolveMethodAuth` surfaces `internal` with the same method-overrides-service precedence as `public`.
- **`createInternalAuthInterceptor`** — for `internal` methods, authorizes via a pluggable per-service **trust source** (`(req) => AuthContext | null`) and rejects a missing/invalid marker as `Code.Unauthenticated`; non-`internal` methods are a no-op pass-through. Three trust-source factories ship:
  - **`meshIdentityTrust({ allowlist, header? })`** — production default; verify a mesh-forwarded peer principal (Istio short-form ServiceAccount / SPIFFE id) against an allow-list carrying roles/scopes. Per-service by construction (the mesh issues each workload its own identity). The identity header is stripped after extraction (anti-spoofing).
  - **`signedTokenTrust({ issuers, header? })`** — non-mesh per-service containment via per-service JWT/JWKS. **The JWKS lookup is issuer-bound**: the keyset is selected by the token's `iss` claim (`issuers[iss].jwksUri`, one `createRemoteJWKSet` per issuer) and verification is pinned to that same issuer. A single shared JWKS across issuers does NOT contain compromise (jose resolves the signing key by `kid` independently of `iss`), so a token claiming `iss: B` signed with A's key is rejected.
  - **`sharedSecretTrust({ secret, header? })`** — **dev-only** fallback (single shared secret, constant-time compared). NOT per-service — one compromise forges all callers — and documented as such.
- **`getInternalMethods(services)`** — mirrors `getPublicMethods`; feed both into the JWT interceptor's `skipMethods`.
- **`createProtoAuthzInterceptor`** composes `internal` inclusively within its existing flow (one model, no parallel `requires_identity`): `internal` + identity + no `requires` → allow; `internal` + `requires {roles/scopes}` → the existing roles/scopes check against the internal identity; `internal` + no identity → `Unauthenticated`. The internal/JWT interceptors MUST run before `createProtoAuthzInterceptor` (they populate the `AuthContext` it consumes): `errorHandler → (jwtAuth | internalAuth) → protoAuthz`.

Purely additive — existing `public` and gated behavior are unchanged.

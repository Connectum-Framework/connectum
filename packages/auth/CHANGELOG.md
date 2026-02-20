# @connectum/auth

## 1.0.0-rc.5

### Minor Changes

- [#30](https://github.com/Connectum-Framework/connectum/pull/30) [`745619d`](https://github.com/Connectum-Framework/connectum/commit/745619d718e915e381293ba71c231e691eae0208) Thanks [@intech](https://github.com/intech)! - Proto-based authorization via custom options in `.proto` files.

  New `createProtoAuthzInterceptor()` — authorization based on proto options.
  Proto reader for extracting auth options from DescFile.
  Fix: lazy auth context in proto-authz interceptor.
  tsup splitting enabled.

- [#26](https://github.com/Connectum-Framework/connectum/pull/26) [`e209b5c`](https://github.com/Connectum-Framework/connectum/commit/e209b5cac4f0f8eabb6e88d9d80389917ac5d47e) Thanks [@intech](https://github.com/intech)! - Change JWT key resolution priority from `jwksUri > secret > publicKey` to `jwksUri > publicKey > secret`.

  Asymmetric keys are cryptographically stronger than symmetric secrets, so `publicKey` now takes precedence over `secret` when both are provided. Also improved `publicKey` JSDoc with supported algorithms (RSA, RSA-PSS, EC, EdDSA) and `crypto.subtle.importKey()` examples.

### Patch Changes

- Updated dependencies [[`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add gateway, session interceptors, LRU cache, and security hardening (v2).

  **New interceptors:**

  - `createGatewayAuthInterceptor()` — extract auth context from trusted gateway headers (replaces dead code `createTrustedHeadersReader`)
  - `createSessionAuthInterceptor()` — convenience wrapper for session/cookie-based auth (better-auth, lucia, etc.) with LRU caching

  **LRU cache:**

  - `LruCache<T>` — minimal in-memory cache with TTL + max-size eviction
  - Opt-in via `cache: { ttl, maxSize }` in session and generic auth interceptors

  **Security fixes:**

  - SEC-001: `propagatedClaims` filter prevents PII leak in header propagation
  - SEC-002: reject JWT without `sub` claim (previously fell back to "unknown")
  - SEC-005: sanitize `subject` and `type` header values

  **Header propagation:**

  - `AUTH_HEADERS.NAME` added for name propagation
  - `setAuthHeaders` / `parseAuthHeaders` support name field

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

- Updated dependencies [[`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177)]:
  - @connectum/core@1.0.0-rc.4

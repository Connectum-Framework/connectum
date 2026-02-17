---
"@connectum/auth": minor
---

Add gateway, session interceptors, LRU cache, and security hardening (v2).

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

---
"@connectum/core": patch
"@connectum/healthcheck": patch
"@connectum/reflection": patch
---

CI/CD and documentation improvements

**CI/CD:**
- Switch to OIDC trusted publishers (no NPM_TOKEN)
- Add PR snapshot publishing via pkg-pr-new
- Fix provenance: use NPM_CONFIG_PROVENANCE env var instead of CLI argument

**Docs:**
- Fix healthcheck README: clarify Check/Watch (standard) + List (extension), license MIT → Apache-2.0
- Fix httpHandler.ts JSDoc: HTTP_HEALTH_ENABLED → HealthcheckOptions.httpEnabled
- Add comprehensive reflection README (API, grpcurl, buf curl usage)

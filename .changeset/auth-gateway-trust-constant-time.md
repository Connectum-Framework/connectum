---
"@connectum/auth": patch
---

fix: `createGatewayAuthInterceptor` compares the trust header with each exact `expectedValues` entry through fixed-size SHA-256 digests and `timingSafeEqual` instead of `===`, so the comparison no longer stops at the first differing character. Which values are trusted does not change.

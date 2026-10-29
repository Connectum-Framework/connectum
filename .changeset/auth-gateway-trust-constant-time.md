---
"@connectum/auth": patch
---

fix: `createGatewayAuthInterceptor` compares the trust header with each exact `expectedValues` entry in constant time (through fixed-size digests and `timingSafeEqual`), so neither the position of the first differing character nor the length of a guess shows in the response time. Which values are trusted does not change, CIDR entries included.

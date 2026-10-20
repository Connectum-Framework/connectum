---
"@connectum/auth": patch
---

fix: `createGatewayAuthInterceptor` reads a roles header that is valid JSON but not an array (`123`, `true`, `null`) as a comma-separated list, as the guide documents. A trusted gateway that sends the single role `123` now gives the identity the role `"123"` instead of no roles. A JSON array of strings is still used as sent, and non-string array items are still dropped.

---
"@connectum/auth": minor
---

Change JWT key resolution priority from `jwksUri > secret > publicKey` to `jwksUri > publicKey > secret`.

Asymmetric keys are cryptographically stronger than symmetric secrets, so `publicKey` now takes precedence over `secret` when both are provided. Also improved `publicKey` JSDoc with supported algorithms (RSA, RSA-PSS, EC, EdDSA) and `crypto.subtle.importKey()` examples.

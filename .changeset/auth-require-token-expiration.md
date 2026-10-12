---
"@connectum/auth": minor
---

fix(security): `createJwtAuthInterceptor` and `signedTokenTrust` now reject a signed token that has no `exp` (expiration time) claim. RFC 9068 section 2.2 requires `exp` in a JWT access token, and `jose` only checks it when it is present, so a token minted without it never expired: a leaked one stayed valid until the signing key was rotated.

**BREAKING** for issuers that mint tokens without `exp`. Breaking and shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0. Tokens from mainstream identity providers always carry `exp` and are unaffected. **Migration:** make the issuer add an expiration (preferred), or opt out explicitly with `requireExpiration: false` on `createJwtAuthInterceptor` options or on the issuer entry of `signedTokenTrust`. An expired token is rejected in both modes.

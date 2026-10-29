---
"@connectum/auth": minor
---

fix: with `propagateHeaders` on, an identity that holds a scope containing a space is now rejected with `Unauthenticated` (`Authentication failed`) and is not cached, as NUL, CR, LF and characters above U+00FF already are. Scopes travel in `x-auth-scopes` joined by single spaces and are split on a space when read, so the single granted scope `reports read admin` reached the next hop as three scopes, `admin` among them. `setAuthHeaders` throws a `TypeError` naming `scopes` and writes no header. With `propagateHeaders` off the identity is admitted as before. A verifier that grants scopes with spaces must stop doing so, or turn propagation off.

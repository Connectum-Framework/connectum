---
"@connectum/auth": minor
---

fix: with `propagateHeaders` on, an identity that holds a scope containing a space is now rejected with `Unauthenticated` (`Authentication failed`) and is not cached, as NUL, CR and LF already are. Scopes travel in `x-auth-scopes` joined by single spaces and are split on a space when read, so the single granted scope `reports read admin` reached the next hop as three scopes, `admin` among them. `setAuthHeaders` throws a `TypeError` naming `scopes` and writes no header. With `propagateHeaders` off the identity is admitted as before. An empty scope is rejected the same way: the reader drops empty pieces, so `["a", "", "b"]` was written as `a  b` and read back as `["a", "b"]`. The error message says a scope may not be empty or contain a space. Every list the writer accepts reads back as written. A verifier that grants empty scopes or scopes with spaces must stop doing so, or turn propagation off.

---
"@connectum/interceptors": patch
---

Bump `cockatiel` to `4.0.0`.

`cockatiel` 4.0.0 is ESM-only and raises its minimum Node.js to 22 (aligned with
the framework's `>=22.13.0` floor). The circuit-breaker interceptor remains
behaviorally identical: the policy executor still invokes the error filter
without guarding it (so the mandatory fail-closed `try/catch` around the failure
predicate is retained), and predicate-rejected errors are still rethrown as
unhandled — they do not increment the breaker and, in half-open, close the
circuit. Verified against the 4.0.0 sources; the full interceptors test suite
(158 tests) passes unchanged.

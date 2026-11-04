---
"@connectum/interceptors": patch
---

fix: `createCircuitBreakerInterceptor` now lets only the half-open probe through, as documented. Before, every caller that arrived while the probe was running waited for it: a slow probe held them all, and a successful one released them to the handler together. Such callers are now rejected at once with the same `Unavailable` error as in the open state ("Circuit breaker is open (N consecutive failures)") and never reach the handler. A successful probe still closes the circuit and a failed one opens it again.

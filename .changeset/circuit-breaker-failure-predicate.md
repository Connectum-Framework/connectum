---
"@connectum/interceptors": minor
---

**BREAKING** (behavioral, ×2): explicit-over-hidden resilience defaults and infrastructure-only circuit breaker classification.

1. **`createDefaultInterceptors()` no longer enables resilience interceptors implicitly.** `timeout`, `bulkhead`, `circuitBreaker`, and `retry` now default to disabled; only `errorHandler` and `validation` remain enabled by default. Hidden behavioral logic is unacceptable — enable each interceptor explicitly:

   ```typescript
   // Before (implicit): createDefaultInterceptors()
   // After (explicit):
   createDefaultInterceptors({
     timeout: true,
     bulkhead: true,
     circuitBreaker: true,
     retry: true,
   });
   ```

2. **Circuit breaker now classifies errors.** Only infrastructure codes trip the breaker by default (`unknown`, `deadline_exceeded`, `internal`, `unavailable`, `data_loss`, `resource_exhausted`, plus non-`ConnectError` values). Business codes (`invalid_argument`, `not_found`, `failed_precondition`, `already_exists`, ...) no longer open the circuit, and in half-open state they close it. New `failurePredicate(error, defaultPredicate)` option composes with or replaces the default policy; `defaultFailurePredicate` is exported. Restore legacy all-errors counting with:

   ```typescript
   createCircuitBreakerInterceptor({ failurePredicate: () => true });
   ```

The circuit breaker is repositioned in the docs as an outbound/client-transport pattern; for inbound protection prefer explicit `timeout` + `bulkhead`. Guaranteed ordering: the breaker wraps retry, so one logical request increments the failure counter at most once.

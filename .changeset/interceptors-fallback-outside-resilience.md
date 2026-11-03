---
"@connectum/interceptors": minor
---

fix: in `createDefaultInterceptors`, the `fallback` interceptor now stands outside `circuitBreaker` and `retry`, so enabling it no longer disables them. Before, the fallback sat inside both and turned the first failure of the handler into a success: the handler ran once with `retry: { maxRetries: 3 }` (not four times), and the breaker never saw a failure, so it never opened. Now the handler is retried first, the fallback value is served after the retries are exhausted, and the breaker opens at its threshold; while it is open, the fallback value answers the refused calls without calling the handler. The fallback handler receives the final error (for an open breaker, the `Unavailable` "Circuit breaker is open" error). A call that succeeds on a retry is served as it is and the fallback is not asked.

When a fallback is enabled, validation moves out with it and stands directly outside the fallback, so a request that breaks a validation rule is still rejected with `InvalidArgument` and never answered by the fallback value: `errorHandler, timeout, bulkhead, validation, fallback, circuitBreaker, retry, serializer`. The chain is unchanged when no `fallback` is given.

This changes the result for anyone who combines `fallback` with `retry` or `circuitBreaker` (published 1.2.0 behaviour: no retries and a breaker that never opens; now retries run and the breaker opens), hence a minor release. If you compose the chain yourself, list `createFallbackInterceptor` before `createCircuitBreakerInterceptor` and `createRetryInterceptor`, and a validation interceptor before the fallback.

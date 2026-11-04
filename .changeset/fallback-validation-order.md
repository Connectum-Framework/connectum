---
"@connectum/interceptors": minor
---

fix: with `fallback` enabled in `createDefaultInterceptors`, a request that fails validation is no longer answered with the fallback value as a successful response. The chain order is now `errorHandler, timeout, bulkhead, circuitBreaker, retry, validation, fallback, serializer`: validation stands outside the fallback, so the caller receives `INVALID_ARGUMENT` and neither the handler nor the fallback handler runs. The fallback still answers failures of the handler, timeouts and bugs. The array differs from before only when `fallback` is enabled; if you compose the chain yourself, put the validation interceptor before the fallback interceptor.

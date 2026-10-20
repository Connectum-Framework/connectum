---
"@connectum/events": patch
---

fix: `retryMiddleware` (and `middleware.retry` of an `EventBus`) refuses a `maxRetries` that cannot work when it is created. Before, a negative number or `NaN` made the attempt loop skip the handler, so the handler never ran and `undefined` was thrown to the dead-letter middleware, which then published an event that had not been processed. Now `maxRetries` must be an integer of at least 0 (`TypeError` for a non-number, `RangeError` otherwise, with the option name and the received value in the message). `0` still means "run once, no retries", and an omitted value still means 3.

A fractional `maxRetries` (for example `2.5`) used to be accepted and now throws at creation; use a whole number.

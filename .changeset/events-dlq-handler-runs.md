---
"@connectum/events": minor
---

feat: the dead-letter copy of a failed event now carries `dlq.handler-runs`, the number of times the handler was invoked for that delivery, first run included. `dlq.attempt` keeps its meaning (the broker's delivery number of the original), so an operator reading the DLQ no longer sees `dlq.attempt=1` for an event whose handler ran three times; `dlq.handler-runs` is `3` there. The value comes from the retry middleware and is `1` when the DLQ middleware runs without it, with `maxRetries: 0`, or when the first error is not retried. Additive: existing headers are unchanged, and consumers that ignore unknown metadata keys are unaffected.

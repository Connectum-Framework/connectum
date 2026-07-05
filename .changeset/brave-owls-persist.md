---
"@connectum/events-amqp": minor
---

feat: `publishRetry` — opt-in bounded publish retry for connection-class outcomes (#195)

- New top-level `publishRetry: boolean | AmqpPublishRetryOptions`: a `publish()` failing with `AmqpConnectionError` (publish during a recovery window; in-flight confirm lost to a drop) retries in place — a short broker blip becomes a transparent delay instead of an instant rejection. Backoff mirrors the recovery formula; `maxRetries` defaults to a bounded `5`. `AmqpPublishTimeoutError` joins only via `retryOnTimeout: true`.
- The auto-retry boundary is the exported **`isAutoRetriablePublishError`** — deliberately narrower than the at-least-once republish matrix (a broker nack is republish-safe by policy but never auto-retried inline; deterministic outcomes never retry). Docs distinguish the two boundaries explicitly.
- At-least-once framing documented honestly: a retry after an in-flight confirm loss may duplicate; `x-event-id`/`messageId` stay stable across attempts (incl. `externalContract`) as the consumer-side dedup anchor.
- Shutdown-aware and drain-covered: the loop aborts promptly on `disconnect()` (interruptible backoff) and lives inside the `adapter.publish()` promise, so the bus-level `drainPublishTimeout` covers retries automatically. Under single-flight correlation, retries hold the chain (ordering preserved; head-of-line blocking documented). The publish channel is re-resolved per attempt.
- Default off — publish behavior unchanged unless opted in.

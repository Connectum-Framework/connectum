---
"@connectum/events-amqp": patch
---

fix: `publish()` no longer reports an argument that amqplib cannot encode as `AmqpConnectionError`, and `publishRetry` no longer repeats it. A routing key or `messageId` over 255 bytes, or a `timestamp` that is NaN, negative, fractional or infinite, now rejects with amqplib's own `TypeError`/`RangeError` (it names the field) and is not retriable. Before, such a call was wrapped as a retriable connection failure, so `publishRetry` spent its whole budget on it and `maxRetries: Infinity` never stopped.

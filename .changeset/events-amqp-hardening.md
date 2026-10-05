---
"@connectum/events-amqp": patch
---

Harden publish and connection lifecycle handling in `@connectum/events-amqp`:

- `publish()` is accepted only on a usable connection. During `connect()` (including its startup probe) and after a connection loss it rejects with the typed `AmqpConnectionError` ("not connected") instead of a raw "Channel closed" from a dead channel; `publishRetry` re-checks before every attempt.
- A `connect()` superseded by `disconnect()` now closes the connection it opened and rejects, so `connect()` → `disconnect()` → `connect()` no longer leaves an orphan connection on the broker. A second `connect()` while one is still running (without `disconnect()` in between) is refused with `AmqpConnectionError("AmqpAdapter: connect() already in progress")` instead of silently opening a second connection.
- `publishTimeoutMs` of `NaN`, `Infinity`, `0`, a negative number or a fraction below 1 no longer makes every publish time out after about 1 ms: such a value is read as unset (30000 ms), and a value above 2147483647 is capped to it.
- `publishRetry.maxRetries: -Infinity` now means a single attempt, like any other negative number; `NaN` means the default of 5.
- Documentation: a consumer-side `decode` failure rejects the message without requeue and throws nothing (it never raised `AmqpSerializationError`); README describes a manual `connect()` after the broker closed the connection with `recovery: false`.

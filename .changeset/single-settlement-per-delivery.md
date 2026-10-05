---
"@connectum/events-amqp": patch
---

fix: a delivery is settled at most once — a handler that calls `ack()` or `nack(false)` and then throws no longer makes the adapter settle the same delivery again

- Before: the adapter's fallback requeue after a rejected handler reached the broker for a delivery tag the handler had already settled. RabbitMQ answers that with `PRECONDITION_FAILED - unknown delivery tag` and closes the consumer channel, and the adapter reported nothing, so the consumer silently stopped receiving messages.
- Now: the first settlement of a delivery wins (`ack()`, `nack()`, `nack(false)`, the requeue after a rejected handler, the reject after a `decode` failure). Every later settlement of the same delivery resolves without reaching the broker, without a lifecycle event. A handler that throws without settling is requeued as before.
- `FakeAmqpAdapter` follows the same rule when it counts settlements in `control.deliver()`, and a bare `nack()` is counted as a requeue (only `nack(false)` is a reject), as in the real adapter.

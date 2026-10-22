---
"@connectum/events": minor
---

feat: `MemoryAdapter` now redelivers an event that its handler `nack`s with requeue. Until now its `nack` did nothing, so a handler's retry-by-nack worked on every real broker and silently dropped the event in tests built on `MemoryAdapter`. `nack(true)` (and `nack()`) returns the event to the same subscription as a later task with `attempt` raised by one; `nack(false)` discards it. A redelivery still waiting when the subscription is removed or the adapter disconnects is dropped, which is also what keeps a stopping `EventBus` from looping nack, redeliver, nack while it drains. A handler that nacks every time is redelivered for as long as its subscription lives, as on a broker; the redelivery runs between timers and I/O, never synchronously. Code that relied on a requeued event being lost must now ack it or `nack(false)`.

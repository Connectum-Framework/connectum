---
"@connectum/events": patch
---

fix: stopping the server or the bus no longer dead-letters an event that is waiting between retries. The retry middleware used to throw the abort reason, so the dead-letter middleware published the event to the DLQ with `dlq.error=AbortError` (or `UnknownError` when `drainTimeout` ended the wait) and acknowledged it, although it still had retry budget and had not been retried. Now a stop returns the event to the broker (`nack` with requeue) and the DLQ stays empty. The broker delivers it again after the restart with a fresh retry budget, so handlers must stay idempotent, as for any redelivered message. `MemoryAdapter` keeps nothing across a stop, so the event is dropped there. An abort caused by the per-event `handlerTimeout` is still a failure and is still dead-lettered, and a handler that fails while the bus is stopping is still dead-lettered as documented.

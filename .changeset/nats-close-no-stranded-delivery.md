---
"@connectum/events-nats": patch
---

fix: closing a subscription no longer strands a message for `ack_wait`. The client forgot the subscription the moment it began to close, while the server learned of it only when the unsubscribe arrived. A message the server dispatched to the consumer's pending pull request in between reached a subscription the client no longer knew and was dropped without a trace; it stayed awaiting an acknowledgement until `ack_wait` (30 s by default) ran out, so the next consumer of the group received it that much later. This showed on `EventBus.stop()` and on the abort of the shutdown signal for a message published within milliseconds of the close.

`unsubscribe()` now drains the subscription first: it sends the unsubscribe, waits for the server to confirm it (bounded to 5 s, so a lost connection does not hold the close) and keeps receiving meanwhile. A message that still arrives reaches the consume loop and goes back to the group through the handler, which the bus nacks once reception has ended.

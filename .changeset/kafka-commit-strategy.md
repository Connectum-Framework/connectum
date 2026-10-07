---
"@connectum/events-kafka": minor
---

Add `consumerOptions.commitStrategy` to choose when the consumer group's offset is committed.
`"per-message"` (the default, unchanged behavior) sends one `OffsetCommit` request for every
acknowledged message. `"per-batch"` makes `ack()` remember the message and sends a single
`OffsetCommit` for the last acknowledged one when the adapter stops working on the batch: at its
end, at a requeued or unsettled message, when the handler throws, when the consumer stops and
when the group membership is lost. Acknowledged messages are not left uncommitted on any of
these exits, and an unsettled message is never committed. The trade-off is a larger window of
duplicates: if the process dies between an `ack()` and the end of the batch, every message
acknowledged in that batch is delivered again, so handlers must be idempotent. Any other value
makes `KafkaAdapter()` throw a `RangeError`.

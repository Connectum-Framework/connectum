---
"@connectum/events-kafka": patch
---

fix: acknowledgement now commits the consumer-group offset, and unsettled messages are redelivered in order

- `ack()` and `nack(false)` commit the message offset; previously nothing was committed, so a restarted group received acknowledged messages again, and messages published while a group was stopped could be lost.
- A handler that throws, calls `nack(true)`, or returns without settling ends the batch: that message and the rest of the partition's batch are delivered again, in order. Previously the message and the rest of its batch were skipped and never redelivered. A failed commit stops the batch and is surfaced to KafkaJS.
- A handler error is now logged with topic, partition and offset instead of being swallowed.
- New `consumerOptions.redeliveryDelay` (milliseconds, default `1000`) pauses the partition between redeliveries of an unsettled message; `0` redelivers immediately. On an otherwise idle consumer the observed gap is a whole fetch cycle (5 s in KafkaJS) even for smaller values. A message that fails on every delivery blocks its partition until the handler succeeds, `nack(false)` is called, or the DLQ middleware moves it.
- `fromBeginning` still defaults to `false`; the README now states what that means for a group without a committed offset.

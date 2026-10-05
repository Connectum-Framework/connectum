---
"@connectum/events-kafka": patch
---

Fix a handler that runs longer than the consumer's `sessionTimeout` being dropped from its
group and the message redelivered forever. KafkaJS sends a heartbeat only when asked, and the
adapter asked only between messages, so during a long handler the broker saw no heartbeat,
removed the member, and every `ack()` then failed with "The coordinator is not aware of this
member". The adapter now heartbeats in the background for as long as a handler runs and stops as
soon as the handler returns or throws. If a heartbeat fails and the message was not
committed, the failure is handed to KafkaJS so the consumer rejoins the group. No option changes.

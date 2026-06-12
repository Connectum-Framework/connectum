---
"@connectum/events": minor
---

Remove `PublishOptions.sync`.

The flag was a no-op: every adapter already confirms publishes per-message
(NATS `PubAck`, Kafka `producer.send`, Redis `XADD`, AMQP per-message broker
ack with typed errors on nack/return/timeout). A resolved `publish()` already
means the broker accepted the message — there was no fire-and-forget mode to
opt out of. Removed ahead of the first stable release; drop `sync` from any
`publish()` calls (no behavior change).

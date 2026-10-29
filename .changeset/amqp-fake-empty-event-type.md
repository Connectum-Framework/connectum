---
"@connectum/events-amqp": patch
---

fix: `FakeAmqpAdapter` (`@connectum/events-amqp/testing`) no longer delivers an event with an empty type to a subscription on `*` or `>` on a topic exchange. RabbitMQ reads the empty routing key as zero words, so it reaches only a subscription to the empty key itself; the fake used the shared EventBus matcher, which counts an empty string as one word. Compared against RabbitMQ over 13 patterns and 12 event types, these two cases were the only differences.

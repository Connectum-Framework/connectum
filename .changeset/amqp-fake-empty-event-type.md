---
"@connectum/events-amqp": patch
---

fix: `FakeAmqpAdapter` (`@connectum/events-amqp/testing`) no longer delivers an event with an empty type to a subscription on `*` or `>` on a topic exchange. RabbitMQ reads the empty routing key as zero words, so only a subscription to the empty key receives it. The fake used the shared EventBus matcher, which counts an empty string as one word. A comparison of 13 patterns and 12 event types against RabbitMQ, reported in the issue, found these two cases as the only differences.

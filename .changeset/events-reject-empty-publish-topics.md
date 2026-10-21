---
"@connectum/events": patch
"@connectum/events-kafka": patch
"@connectum/events-nats": patch
---

fix: `publish()` now refuses, before it reaches the broker, the topics that the adapter's broker cannot serve, with a `TypeError` that names the adapter and the topic. NATS and the in-memory adapter refuse a topic with an empty token (the empty string, `a..b`, `.a`, `a.` and `.`); Kafka refuses `""`, `.` and `..`, the topic names Kafka reserves. This is the publishing side of the check `subscribe()` already makes. Other adapters are unchanged: `a..b`, `.a` and `a.` stay valid Kafka topics, and Redis and RabbitMQ accept any key.

Earlier versions failed late or not at all: `NatsAdapter` answered every one of these topics with `jetstream is not enabled` and stored nothing, `KafkaAdapter` answered its reserved names with a broker error that does not name the topic, and `MemoryAdapter` delivered the event to wildcard subscribers although no subscription pattern could name that topic. `@connectum/events` exports the check as `assertPublishTopic({ adapter, topic, rule })` for custom adapters, with the same `rule` values as `assertSubscriptionPatterns`.

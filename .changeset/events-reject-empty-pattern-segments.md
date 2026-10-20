---
"@connectum/events": patch
"@connectum/events-kafka": patch
"@connectum/events-nats": patch
---

fix: `subscribe()` now refuses, before it reaches the broker, the subscription patterns that the adapter's broker cannot serve, with a `TypeError` that names the adapter and the pattern. NATS and the in-memory adapter refuse a pattern with an empty token (the empty string, `a..b`, `.a`, `a.` and `.`); Kafka refuses `""`, `.` and `..`, the topic names Kafka reserves. Other adapters are unchanged: `a..b`, `.a` and `a.` stay valid Kafka topic names, and Redis and RabbitMQ accept any key.

Earlier versions accepted these patterns and failed late: `NatsAdapter` with `jetstream is not enabled` (the server never answers a consumer request whose subject has an empty token), `KafkaAdapter` with `invalid topic` after it had connected a consumer. A bad pattern next to good ones now leaves no consumer or consumer group behind, and `EventBus.start()` fails with the new error. `@connectum/events` exports the check as `assertSubscriptionPatterns({ adapter, patterns, rule })` for custom adapters; `rule` is `"no-empty-segment"` (default) or `"kafka-topic-name"`.

---
"@connectum/events": patch
"@connectum/events-amqp": patch
"@connectum/events-kafka": patch
"@connectum/events-nats": patch
"@connectum/events-redis": patch
---

fix: every event adapter now rejects a subscription pattern that contains an empty segment: the empty string, `a..b`, `.a`, `a.` and `.`. `subscribe()` throws a `TypeError` that names the adapter, the pattern and where the empty segment is (`NatsAdapter: subscription pattern "a..b" has an empty segment (it contains ".."). Every dot-separated segment of a pattern must be non-empty.`), before it creates any queue, consumer, stream or consumer group, so a bad pattern next to good ones leaves nothing behind and `EventBus.start()` fails with that error. The wildcards `*` and `>` are not affected.

Earlier versions accepted these patterns and each adapter reacted differently: `AmqpAdapter` bound the queue to the empty key, `RedisAdapter` created a stream for it, and `NatsAdapter` and `KafkaAdapter` failed with a broker error that did not name the pattern (`jetstream is not enabled`, `invalid topic`). A route whose topic has an empty segment now fails at start; correct the topic. `@connectum/events` exports the check as `assertSubscriptionPatterns()` for custom adapters; `toAmqpPattern("")` now throws instead of returning `""`.

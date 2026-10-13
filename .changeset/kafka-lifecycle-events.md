---
"@connectum/events-kafka": minor
---

feat: `KafkaAdapter` reports its lifecycle through `lifecycle.onLifecycle`, the same pattern as `@connectum/events-amqp`. Until now a crashed consumer was invisible: the client library stopped retrying and, unless it restarted the consumer, the subscription went quiet without a trace.

The events (a union on `type`, local to this package): `connected { reconnected: false }` once, when the producer has connected; `consumer-lost { groupId, error, willRestore }` when a subscription's consumer crashed (the client gave up its own retries; `willRestore` says whether it will restart on its own); `consumer-restore-failed { groupId, attempt, error, willRetry }` for a crash before the consumer came back; `consumer-restored { groupId, attempt }` for the first group join after a crash. A group join without a preceding crash, rebalances, and the restart that topic discovery causes produce nothing, and neither do the adapter's own `unsubscribe()` and `disconnect()`. A callback that throws or returns a rejected promise is isolated and reported once as `lifecycle-error`; this matters because the client library runs its listeners inside the code that schedules the restart of a crashed consumer, where an exception would silently kill the subscription. A returned promise is not awaited.

`disconnected`, `reconnecting` and `reconnect-failed` are not emitted for Kafka: the client library reports no loss of the producer's connection, and a consumer rides out a short broker outage without any event, so inventing them from failed sends would be guessing. Without the option no listener is attached to the client and nothing changes.

---
"@connectum/events": patch
---

`EventBus.stop()` now honours `drainTimeout` on the Redis, Kafka and NATS adapters. Closing a subscription on these adapters waits for the handler that is running, and the bus used to wait for that close before it started the drain, so a stuck handler (for example one in a retry backoff) was released only by `handlerTimeout`: with a 5 s `drainTimeout`, `stop()` took about 30 s on Redis. The close and the drain now run at the same time; after `drainTimeout` the handler's signal aborts with the reason `"Drain timeout exceeded"`, which lets the close finish. The adapter is still disconnected only after both have finished. No option, event or default changes.

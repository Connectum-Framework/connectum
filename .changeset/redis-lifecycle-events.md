---
"@connectum/events-redis": minor
---

feat: `RedisAdapter` reports its connection lifecycle through `lifecycle.onLifecycle`, the same pattern as `@connectum/events-amqp`. Until now nothing told an operator that the Redis connection had dropped or that the client had given up.

The events (a union on `type`, local to this package), each carrying `connection`: `"publisher"` for the publishing connection or `{ group, patterns }` for the dedicated blocking connection of one subscription. `connected { reconnected }` on a connection's first ready (`false`) and after every recovery (`true`); `disconnected { error }` once per loss of a connection that had been ready, however many reconnect attempts then fail; `reconnecting { attempt, delay, error }` for every scheduled attempt (the attempt counter restarts on ready); and the terminal `reconnect-failed { error }` when the client ends without the adapter closing it, which needs a `retryStrategy` that stops returning a delay. One loss of the server is reported once per connection, so an adapter with N subscriptions reports N+1 `disconnected` events. Nothing is reported before a connection's first ready (`connect()` rejects with the error itself) nor for the adapter's own `disconnect()` and `unsubscribe()`. A callback that throws or returns a rejected promise is isolated and reported once as `lifecycle-error`; a returned promise is not awaited.

Without the option no listener is attached and nothing changes. With it, an `error` listener is attached to every connection, so the client's own `[ioredis] Unhandled error event` line on stderr is replaced by the cause carried in the events.

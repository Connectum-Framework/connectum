---
"@connectum/events-nats": minor
---

feat: `NatsAdapter` reports its connection lifecycle through `lifecycle.onLifecycle`, the same pattern as `@connectum/events-amqp`. Until now an operator could not observe or alert on the broker connection of the NATS adapter, and a client that gave up reconnecting left the adapter unusable without any signal.

The events (a union on `type`, local to this package): `connected { reconnected }` once after the first connect and once per recovery (`server` set), `disconnected { server }` once per loss, `reconnecting { attempt }` for every dial after a loss (the client reports one per address it tries; it reports no delay or error, so none is given), and the terminal `reconnect-failed { error }` when the client closes itself without a `disconnect()` call, typically after its reconnect budget ran out. `staleConnection`, `forceReconnect`, `error`, `ldm`, `update`, `ping` and `slowConsumer` produce nothing. `disconnect()` produces no loss event. A callback that throws or returns a rejected promise is isolated and reported once as `lifecycle-error`; a returned promise is not awaited, so a slow callback never delays `disconnect()`.

Without the option no listener is attached to the client and nothing changes. Events of the initial dial that happen before `connect()` returns are not available from the client. After `reconnect-failed` the adapter object is still unusable, as before; the event makes it visible.

---
"@connectum/events-amqp": patch
---

fix: `disconnect()` now cancels a `connect()` that is still waiting for an unreachable broker. With the default recovery (no `recovery.initialConnectMaxRetries`) the startup retry loop was unlimited and out of reach of `disconnect()`: `connect()` never settled, `createServer({ eventBus })` stayed in `starting`, and the process could not exit on its own. The cancelled `connect()` now closes the connection it opened and rejects with `AmqpConnectionError("Adapter closed during the initial connect phase")`; no retry timer is left behind. Lifecycle reporting is unchanged: without `initialConnectMaxRetries` the failed startup attempts are still not reported.

The same holds when the `connect()` waits on a socket that never answers its handshake or its setup: the startup probe (used with `lifecycle.onLifecycle`, `lifecycle.onSetupFailed` or `failFastOnInitialSetupError`), the single connection of `recovery: false` and the attempt of a recovering connection that is already in its handshake. `disconnect()` destroys those sockets and the pending `connect()` rejects with `AmqpConnectionError`; before, such a `connect()` never settled and the socket stayed open. A `socketOptions.signal` you pass keeps working.

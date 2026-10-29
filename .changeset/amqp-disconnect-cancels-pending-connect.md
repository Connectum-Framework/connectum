---
"@connectum/events-amqp": patch
---

fix: `disconnect()` now cancels a `connect()` that is still waiting for an unreachable broker. With the default recovery (no `recovery.initialConnectMaxRetries`) the startup retry loop was unlimited and out of reach of `disconnect()`: `connect()` never settled, `createServer({ eventBus })` stayed in `starting`, and the process could not exit on its own. The cancelled `connect()` now closes the connection it opened and rejects with `AmqpConnectionError("Adapter closed during the initial connect phase")`; no retry timer is left behind. Lifecycle reporting is unchanged: without `initialConnectMaxRetries` the failed startup attempts are still not reported.

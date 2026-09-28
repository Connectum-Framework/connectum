---
"@connectum/events-amqp": patch
---

fix: amqplib 2.2.0 baseline — bounded delays and a clean terminal state after recovery gives up

- **amqplib floor raised to `^2.2.0`.** Consumers of the previous `^2.0.1` range already resolved 2.2.0; the package is now built and tested against it. amqplib 2.2.0 caps its recovery base at `maxDelay / (1 + jitter)`, so a reconnect delay never exceeds `maxDelay` (default saturation: 20–30 s, previously 24–36 s), and channel operations reject instead of waiting forever once recovery has given up.
- **Adapter-owned delays follow the same formula.** The bounded initial connect (`initialConnectMaxRetries`) and `publishRetry` now compute their backoff exactly like amqplib 2.2.0, so they no longer overshoot `maxDelay` either.
- **Recovery give-up is a clean terminal state.** When a finite `maxRetries` is exhausted (terminal `reconnect-failed`), the adapter now drops the dead connection, its publish channel and its subscription records before reporting the event — the same teardown as the fatal topology stop. Previously it kept the dead connection: `subscribe()` hung (amqplib 2.0.1) or rejected with a raw socket error (2.2.0), a `publishRetry` publish spent its whole retry budget, and `connect()` refused with "already connected". Now `subscribe()` and `publish()` reject at once with `AmqpConnectionError` ("not connected"), and a later `connect()` starts from a clean slate without the old subscriptions — re-subscribe explicitly.
- **`FakeAmqpAdapter` (`@connectum/events-amqp/testing`) follows the new terminal state:** after `control.exhaustRecovery()` a fresh `connect()` is accepted (it used to throw "already connected" until `disconnect()`), and the old subscriptions are dropped instead of only deactivated.

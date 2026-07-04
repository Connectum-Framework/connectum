---
"@connectum/events-amqp": minor
---

feat: discriminated `onLifecycle` connection-lifecycle callback (#197)

- New `lifecycle.onLifecycle(event)` — a single discriminated union (`type`: `connected` | `disconnected` | `reconnecting` | `reconnect-failed` | `setup-failed` | `blocked` | `unblocked`) with exactly-once semantics pinned by integration tests. `connected` carries `reconnected: boolean`; `blocked`/`unblocked` surface RabbitMQ flow control (`connection.blocked`) for the first time. Scope: per-retry events of the *initial* connect loop are not yet surfaced (tracked in #198).
- Setting `onLifecycle` (like `onSetupFailed` / `failFastOnInitialSetupError`) enables the startup validation probe — one extra short-lived connection plus a topology validation pass at `connect()` (recovery enabled required) — so `setup-failed { initial: true }` is delivered for a deterministic misconfiguration at boot.
- Lifecycle callbacks must not throw: exceptions are now isolated in dispatch (a throwing callback can no longer make amqplib's recovery close a healthy connection or skip reconnect scheduling; the union and flat surfaces cannot starve each other).
- The flat callbacks (`onConnected`, `onDisconnected`, `onReconnecting`, `onReconnectFailed`, `onSetupFailed`) are now a compatibility shim over the union and are `@deprecated` since 1.3.0 (removal not before 2.0). When both are set, flat callbacks fire after `onLifecycle`.
- **Behavior fix (documented):** a socket-level connection cut fired `onDisconnected` twice — once via the raw connection `error` re-emit and once via the recovery `disconnect` event; it now fires exactly once per drop on both surfaces. Disconnect-counter metrics of existing consumers will roughly halve. A graceful server close was and remains single-fire.
- **Behavior fix (documented, `recovery: false` mode):** `disconnected` is now delivered once per connection loss on the connection `close` (with the preceding `error` kept as the cause) — including a server-forced graceful close, which previously surfaced no event at all. The adapter's own `disconnect()` and a failed-setup discard do not emit it.
- Hardening: the startup probe connection now carries an `error` listener (a broker drop during the probe window could previously crash the process via an unhandled `error` event); a stale reconnect-attempt counter no longer leaks into a later `connect()` incarnation.

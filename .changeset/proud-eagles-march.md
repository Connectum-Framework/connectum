---
"@connectum/events-amqp": minor
---

feat: `initialConnectMaxRetries` — bounded, observable initial connect (#198)

- New `recovery.initialConnectMaxRetries` (N retries = N+1 attempts, mirroring `maxRetries` semantics): expresses "bounded startup, unbounded steady-state", which a single `maxRetries` cannot (its counter resets on every success). Default unset — behavior unchanged.
- When set, the adapter owns the initial window with a bounded validate-connect loop — the 1.2.0 startup probe folds into it (validation IS each attempt, no extra connects). Budget exhaustion rejects `connect()` with a typed `AmqpConnectionError` after a terminal `reconnect-failed` — never a silent block.
- **Initial-window observability**: per-attempt lifecycle events are now surfaced during the bounded phase (`reconnecting { attempt, delay }`, `setup-failed { initial: true, attempt }`) — previously the initial retry loop ran inside amqplib before any wiring could attach and was silent. This closes the documented scope gap from the `onLifecycle`/`treatTopologyErrorAsFatal` releases.
- Backoff uses amqplib's built-in formula as of amqplib 2.2.0 (same knobs; the base is capped at `maxDelay / (1 + jitter)`, so a delay never exceeds `maxDelay`; pinned by unit tests). `failFastOnInitialSetupError` still short-circuits deterministic topology errors immediately; the backoff sleep is interruptible by `disconnect()`.
- amqplib 2.2.0 added a native `initialMaxRetries`; this option stays the adapter's own loop, because amqplib reports its per-attempt events before `connect()` resolves (before the adapter's lifecycle wiring is attached) and rejects with the raw last error on exhaustion.

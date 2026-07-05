---
"@connectum/events-amqp": minor
---

feat: `initialConnectMaxRetries` — bounded, observable initial connect (#198)

- New `recovery.initialConnectMaxRetries` (N retries = N+1 attempts, mirroring `maxRetries` semantics): expresses "bounded startup, unbounded steady-state", which a single `maxRetries` cannot (its counter resets on every success). Default unset — behavior unchanged.
- When set, the adapter owns the initial window with a bounded validate-connect loop — the 1.2.0 startup probe folds into it (validation IS each attempt, no extra connects). Budget exhaustion rejects `connect()` with a typed `AmqpConnectionError` after a terminal `reconnect-failed` — never a silent block.
- **Initial-window observability**: per-attempt lifecycle events are now surfaced during the bounded phase (`reconnecting { attempt, delay }`, `setup-failed { initial: true, attempt }`) — previously the initial retry loop ran inside amqplib before any wiring could attach and was silent. This closes the documented scope gap from the `onLifecycle`/`treatTopologyErrorAsFatal` releases.
- Backoff replicates amqplib's steady-state formula exactly (same knobs, same cap-before-jitter semantics; pinned by unit tests against the documented formula). `failFastOnInitialSetupError` still short-circuits deterministic topology errors immediately; the backoff sleep is interruptible by `disconnect()`.
- Upstream native support remains tracked in amqp-node/amqplib#856 (this implementation becomes a passthrough if it lands).

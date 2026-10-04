---
"@connectum/events-amqp": minor
---

feat: `recovery.backoff` — a custom reconnect delay hook

- New optional `recovery.backoff: (attempt: number) => number`, forwarded to amqplib's `calculateDelay`. It sets the delay of every reconnect attempt — steady-state recovery and the retries of the initial connect, with or without `initialConnectMaxRetries` — but not `publishRetry`. `attempt` is 1-based and restarts after every successful connect; a valid return (finite, ≥ 0) is rounded and applied as is, **not** clamped to `maxDelay`; `0` retries at once; `reconnecting.delay` reports the applied value.
- **A failing hook ends recovery.** The hook must be synchronous: a throw, an invalid return (`NaN`, `Infinity`, negative, a numeric string) or a Promise gives recovery up with no fallback to the built-in schedule. The initial `connect()` rejects, or in steady state the terminal `reconnect-failed` fires once and the adapter enters its dead-cycle state; either way the error is an `AmqpConnectionError` with the hook's error as `cause` and the last connection error named in the message. A later rejection of an `async` hook's Promise is not left unhandled.
- **Rejected combinations.** `backoff` together with `initialDelay`, `maxDelay`, `factor` or `jitter` throws a `TypeError` at adapter construction — amqplib ignores those knobs once a hook is set. `maxRetries` and `initialConnectMaxRetries` stay valid with the hook. The combination involves the new option only, so no existing configuration starts failing.

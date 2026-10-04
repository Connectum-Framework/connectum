---
"@connectum/events-amqp": minor
---

feat: amqplib runs the bounded initial connect (`initialConnectMaxRetries`)

- **One loop for every reconnect attempt.** `recovery.initialConnectMaxRetries` is now forwarded to amqplib's own `initialMaxRetries`; the adapter no longer runs its own loop of throwaway validating connections. The public contract is unchanged: a finite N gives at most `max(0, floor(N)) + 1` attempts, `Infinity`/`NaN` count as unset, every retry reports `reconnecting` and a topology failure `setup-failed { initial: true, attempt }` (0-based attempt index), exhaustion reports one terminal `reconnect-failed` and rejects `connect()` with `AmqpConnectionError` ("Initial connect failed after N attempt(s) (initialConnectMaxRetries: M)", last attempt's error as `cause`), `failFastOnInitialSetupError` stops on the first topology error, and `publish()`/`subscribe()` reject "not connected" until the first success.
- **Behavior notes for `initialConnectMaxRetries` users:**
  - **Broker connections.** Each attempt now opens the recovering connection itself and the successful one is kept. Previously every attempt opened a throwaway connection and a separate recovering connection followed the validation; that second connect could still block in amqplib's own loop if the broker died in between. After a success exactly one adapter connection is open; after exhaustion none.
  - **Timing.** The first attempt starts on the next turn of the event loop, and the wait between attempts is amqplib's timer: `disconnect()` during the initial connect cancels it at once (previously within 100 ms).

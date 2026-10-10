# @connectum/events-amqp

## 1.3.0

### Minor Changes

- [#222](https://github.com/Connectum-Framework/connectum/pull/222) [`3a76225`](https://github.com/Connectum-Framework/connectum/commit/3a76225e8ec826bd859d4a0acbdc7dff0d3718bb) Thanks [@intech](https://github.com/intech)! - feat: `publishRetry` — opt-in bounded publish retry for connection-class outcomes ([#195](https://github.com/Connectum-Framework/connectum/issues/195))
  
  - New top-level `publishRetry: boolean | AmqpPublishRetryOptions`: a `publish()` failing with `AmqpConnectionError` (publish during a recovery window; in-flight confirm lost to a drop) retries in place — a short broker blip becomes a transparent delay instead of an instant rejection. Backoff mirrors the recovery formula; `maxRetries` defaults to a bounded `5`. `AmqpPublishTimeoutError` joins only via `retryOnTimeout: true`.
  - The auto-retry boundary is the exported **`isAutoRetriablePublishError`** — deliberately narrower than the at-least-once republish matrix (a broker nack is republish-safe by policy but never auto-retried inline; deterministic outcomes never retry). Docs distinguish the two boundaries explicitly.
  - At-least-once framing documented honestly: a retry after an in-flight confirm loss may duplicate; `x-event-id`/`messageId` stay stable across attempts (incl. `externalContract`) as the consumer-side dedup anchor.
  - Shutdown-aware and drain-covered: the loop aborts promptly on `disconnect()` (interruptible backoff) and lives inside the `adapter.publish()` promise, so the bus-level `drainPublishTimeout` covers retries automatically. Under single-flight correlation, retries hold the chain (ordering preserved; head-of-line blocking documented). The publish channel is re-resolved per attempt.
  - Default off — publish behavior unchanged unless opted in.

- [#301](https://github.com/Connectum-Framework/connectum/pull/301) [`47b7637`](https://github.com/Connectum-Framework/connectum/commit/47b7637567e38a020c05efe965f7410abaf84ad9) Thanks [@intech](https://github.com/intech)! - feat: `recovery.backoff` — a custom reconnect delay hook
  
  - New optional `recovery.backoff: (attempt: number) => number`, forwarded to amqplib's `calculateDelay`. It sets the delay of every reconnect attempt — steady-state recovery and the retries of the initial connect, with or without `initialConnectMaxRetries` — but not `publishRetry`. `attempt` is 1-based and restarts after every successful connect; a valid return (finite, ≥ 0) is rounded and applied as is, **not** clamped to `maxDelay`; `0` retries at once; `reconnecting.delay` reports the applied value.
  - **A failing hook ends recovery.** The hook must be synchronous: a throw, an invalid return (`NaN`, `Infinity`, negative, a numeric string) or a Promise gives recovery up with no fallback to the built-in schedule. The initial `connect()` rejects, or in steady state the terminal `reconnect-failed` fires once and the adapter enters its dead-cycle state; either way the error is an `AmqpConnectionError` with the hook's error as `cause` and the last connection error named in the message. A later rejection of an `async` hook's Promise is not left unhandled.
  - **Rejected combinations.** `backoff` together with `initialDelay`, `maxDelay`, `factor` or `jitter` throws a `TypeError` at adapter construction — amqplib ignores those knobs once a hook is set. `maxRetries` and `initialConnectMaxRetries` stay valid with the hook. The combination involves the new option only, so no existing configuration starts failing.

- [#216](https://github.com/Connectum-Framework/connectum/pull/216) [`82f2c29`](https://github.com/Connectum-Framework/connectum/commit/82f2c299d35e1261e463b71504cbad7da044db02) Thanks [@intech](https://github.com/intech)! - feat: discriminated `onLifecycle` connection-lifecycle callback ([#197](https://github.com/Connectum-Framework/connectum/issues/197))
  
  - New `lifecycle.onLifecycle(event)` — a single discriminated union (`type`: `connected` | `disconnected` | `reconnecting` | `reconnect-failed` | `setup-failed` | `blocked` | `unblocked`) with exactly-once semantics pinned by integration tests. `connected` carries `reconnected: boolean`; `blocked`/`unblocked` surface RabbitMQ flow control (`connection.blocked`) for the first time. Scope: per-retry events of the *initial* connect loop are not yet surfaced (tracked in [#198](https://github.com/Connectum-Framework/connectum/issues/198)).
  - Setting `onLifecycle` (like `onSetupFailed` / `failFastOnInitialSetupError`) enables the startup validation probe — one extra short-lived connection plus a topology validation pass at `connect()` (recovery enabled required) — so `setup-failed { initial: true }` is delivered for a deterministic misconfiguration at boot.
  - Lifecycle callbacks must not throw: exceptions are now isolated in dispatch (a throwing callback can no longer make amqplib's recovery close a healthy connection or skip reconnect scheduling; the union and flat surfaces cannot starve each other).
  - The flat callbacks (`onConnected`, `onDisconnected`, `onReconnecting`, `onReconnectFailed`, `onSetupFailed`) are now a compatibility shim over the union and are `@deprecated` since 1.3.0 (removal not before 2.0). When both are set, flat callbacks fire after `onLifecycle`.
  - **Behavior fix (documented):** a socket-level connection cut fired `onDisconnected` twice — once via the raw connection `error` re-emit and once via the recovery `disconnect` event; it now fires exactly once per drop on both surfaces. Disconnect-counter metrics of existing consumers will roughly halve. A graceful server close was and remains single-fire.
  - **Behavior fix (documented, `recovery: false` mode):** `disconnected` is now delivered once per connection loss on the connection `close` (with the preceding `error` kept as the cause) — including a server-forced graceful close, which previously surfaced no event at all. The adapter's own `disconnect()` and a failed-setup discard do not emit it.
  - Hardening: the startup probe connection now carries an `error` listener (a broker drop during the probe window could previously crash the process via an unhandled `error` event); a stale reconnect-attempt counter no longer leaks into a later `connect()` incarnation.

- [#219](https://github.com/Connectum-Framework/connectum/pull/219) [`d21e3c8`](https://github.com/Connectum-Framework/connectum/commit/d21e3c83f9d799a055cbff3e9594875c85a80869) Thanks [@intech](https://github.com/intech)! - feat: `initialConnectMaxRetries` — bounded, observable initial connect ([#198](https://github.com/Connectum-Framework/connectum/issues/198))
  
  - New `recovery.initialConnectMaxRetries` (N retries = N+1 attempts, mirroring `maxRetries` semantics): expresses "bounded startup, unbounded steady-state", which a single `maxRetries` cannot (its counter resets on every success). Default unset — behavior unchanged.
  - When set, the adapter owns the initial window with a bounded validate-connect loop — the 1.2.0 startup probe folds into it (validation IS each attempt, no extra connects). Budget exhaustion rejects `connect()` with a typed `AmqpConnectionError` after a terminal `reconnect-failed` — never a silent block.
  - **Initial-window observability**: per-attempt lifecycle events are now surfaced during the bounded phase (`reconnecting { attempt, delay }`, `setup-failed { initial: true, attempt }`) — previously the initial retry loop ran inside amqplib before any wiring could attach and was silent. This closes the documented scope gap from the `onLifecycle`/`treatTopologyErrorAsFatal` releases.
  - Backoff uses amqplib's built-in formula as of amqplib 2.2.0 (same knobs; the base is capped at `maxDelay / (1 + jitter)`, so a delay never exceeds `maxDelay`; pinned by unit tests). `failFastOnInitialSetupError` still short-circuits deterministic topology errors immediately; the backoff sleep is interruptible by `disconnect()`.
  - amqplib 2.2.0 added a native `initialMaxRetries`; this option stays the adapter's own loop, because amqplib reports its per-attempt events before `connect()` resolves (before the adapter's lifecycle wiring is attached) and rejects with the raw last error on exhaustion.

- [#298](https://github.com/Connectum-Framework/connectum/pull/298) [`3c354b3`](https://github.com/Connectum-Framework/connectum/commit/3c354b323ae2bc2f0d62a2a2d5932a8b31927bd5) Thanks [@intech](https://github.com/intech)! - fix: faults on the AMQP consume, publish and lifecycle paths are reported instead of lost or crashing
  
  - **A delivery settled after its channel closed no longer escapes as an unhandled rejection.** When a handler rejects, or calls `ack()`/`nack()`, after the connection dropped, the adapter swallows amqplib's closed-channel error and reports a new `settlement-skipped` lifecycle event (`action`, `queue`, `routingKey`, `deliveryTag`, `error`). The broker returns the unacknowledged delivery to the queue when the channel closes, and it arrives again with `attempt` greater than 1; on a quorum queue each such return counts toward the queue's delivery limit (default 20 since RabbitMQ 4.0), and past the limit the broker drops the message or dead-letters it. Any other settlement error is still not hidden.
  - **A throwing or rejecting lifecycle callback is reported, not swallowed.** `onLifecycle` and the flat callbacks may now return a promise; a rejection is isolated exactly like a throw (it is not awaited and never becomes an unhandled rejection) and surfaces as a new `lifecycle-error` event naming the `callback` and the `event` it was handling.
  - **`treatTopologyErrorAsFatal` stops only on deterministic drift.** The gate now reads the reply code together with the broker's message: a missing queue or exchange (`404`) and an incompatible or invalid redeclare, or a bad exchange type (`406`) stop the cycle; the self-healing `404`s (home node down, process stopped or crashed, timeout, leader being demoted) and `406 exchange limit … reached` stay in recovery. A `404`/`406` without a recognised message is treated as transient. The fatal stop remains quiet: observe `reconnect-failed` and restart the bus.
  - **`publishRetry` no longer loops on a channel the broker closed.** When the broker closes the current publish channel with a reply code (`404` missing exchange, `403` internal exchange, `541`, …), the publish rejects at once with the reply as `cause` instead of spending the retry budget — or, with `maxRetries: Infinity`, retrying forever. A connection loss and a channel that was already replaced stay retriable.
  - **`disconnected` carries the broker's reason with `recovery: false`.** The event's `error` is the close error from the broker (its `code` is the reply code, e.g. `320`) rather than a generic `Connection closed`; the generic message remains only as a fallback.

- [#301](https://github.com/Connectum-Framework/connectum/pull/301) [`47b7637`](https://github.com/Connectum-Framework/connectum/commit/47b7637567e38a020c05efe965f7410abaf84ad9) Thanks [@intech](https://github.com/intech)! - feat: amqplib runs the bounded initial connect (`initialConnectMaxRetries`)
  
  - **One loop for every reconnect attempt.** `recovery.initialConnectMaxRetries` is now forwarded to amqplib's own `initialMaxRetries`; the adapter no longer runs its own loop of throwaway validating connections. The public contract is unchanged: a finite N gives at most `max(0, floor(N)) + 1` attempts, `Infinity`/`NaN` count as unset, every retry reports `reconnecting` and a topology failure `setup-failed { initial: true, attempt }` (0-based attempt index), exhaustion reports one terminal `reconnect-failed` and rejects `connect()` with `AmqpConnectionError` ("Initial connect failed after N attempt(s) (initialConnectMaxRetries: M)", last attempt's error as `cause`), `failFastOnInitialSetupError` stops on the first topology error, and `publish()`/`subscribe()` reject "not connected" until the first success.
  - **Behavior notes for `initialConnectMaxRetries` users:**
    - **Broker connections.** Each attempt now opens the recovering connection itself and the successful one is kept. Previously every attempt opened a throwaway connection and a separate recovering connection followed the validation; that second connect could still block in amqplib's own loop if the broker died in between. After a success exactly one adapter connection is open; after exhaustion none.
    - **Timing.** The first attempt starts on the next turn of the event loop, and the wait between attempts is amqplib's timer: `disconnect()` during the initial connect cancels it at once (previously within 100 ms).

- [#305](https://github.com/Connectum-Framework/connectum/pull/305) [`b3012ef`](https://github.com/Connectum-Framework/connectum/commit/b3012eff278a19dcaf0f2a796af82570cd83088d) Thanks [@intech](https://github.com/intech)! - feat: restore a consumer the broker ended, and report it as lifecycle events
  
  - A subscription whose consumer the broker ends while the connection stays up (its queue was deleted, the consumer was cancelled, or the broker closed the consumer channel with a channel exception, for example after an unknown delivery tag) used to go silent: no event, no consumption. The adapter now reports `consumer-lost { queue, cause, error?, willRestore }` once per loss and, with `recovery` enabled, restores the consumer on the live connection: `consumer-restored { queue, attempt }` on success, `consumer-restore-failed { queue, attempt, error, willRetry }` per failed attempt (`willRetry: false` when the failure is deterministic topology drift, such as a missing queue in `check` mode). `cause` is `"cancelled"` or `"channel-closed"`. With `recovery: false` the loss is reported with `willRestore: false` and nothing is restored. The events are part of the `onLifecycle` union only; a connection loss is not a consumer loss.
  - Restoration repeats the subscription's topology step, so in `assert` mode a queue an operator deleted on purpose is declared again (empty); unsubscribe, set `recovery: false` or use `topologyMode: "check"` to keep it gone. Attempts wait the same delay formula as reconnects (`initialDelay`, `factor`, `jitter`, `maxDelay`; the defaults when `recovery.backoff` is set), without an attempt limit; the counter restarts after the consumer has run for `maxDelay` without a new loss. The lost consumer's channel is closed, so a handler still running settles late as `settlement-skipped` and the broker redelivers the message.
  - A handler that throws synchronously is now treated as a rejection (the message is requeued) instead of escaping the consume callback, where amqplib closed the channel with 541 and the subscription went silent.
  - `FakeAmqpAdapter` (`@connectum/events-amqp/testing`): `control.loseConsumer({ queue?, cause?, error? })` and `control.restoreConsumers()` exercise the new handling without a broker; the new `recovery` option sets `willRestore`.

- [#329](https://github.com/Connectum-Framework/connectum/pull/329) [`9f5a68e`](https://github.com/Connectum-Framework/connectum/commit/9f5a68efd5235f2a715d8051ffb7edd839f91d8c) Thanks [@intech](https://github.com/intech)! - fix: align AMQP topic subscriptions with EventBus wildcard matching
  
  **BREAKING** behavior correction. On topic exchanges, terminal `>` now requires
  at least one trailing routing-key segment. The adapter translates `user.>` to
  `user.*.#` instead of `user.#`, rejects a complete `>` token outside the
  terminal position, and rejects a complete `*` or `>` segment on a **direct**
  exchange when the adapter creates the binding itself (`topologyMode: "assert"`):
  such a binding is a literal key and the queue would never receive a message.
  With `topologyMode: "check"` or `"skip"` the operator's bindings decide, so no
  pattern is rejected. Fanout and headers exchanges are unchanged: the queue
  receives every message whatever the pattern, and the EventBus dispatches only
  matching handlers. Topic-exchange subscriptions containing a complete `#`
  segment are also rejected because RabbitMQ would interpret it as a wildcard
  while the common EventBus matcher treats it as literal text. Characters
  embedded in a segment remain literal. Explicit raw topology bindings using `#`
  and `#` routing-key literals on non-topic exchanges retain their
  broker-specific behavior.
  
  `FakeAmqpAdapter` accepts `exchangeType` and `topologyMode`, validates patterns
  exactly like the real adapter, and routes `deliver()` by exchange type (fanout
  and headers reach every subscription).
  
  This is a breaking behavior correction released with the coordinated 1.3 package
  group, consistent with the project's recorded 1.3 exception for breaking
  changes. Existing broad bindings such as `user.#` are not removed automatically;
  operators must inspect and replace them with `user.*.#` while preserving queues
  and queued messages. See the AMQP migration guide.

- [#217](https://github.com/Connectum-Framework/connectum/pull/217) [`f0e9040`](https://github.com/Connectum-Framework/connectum/commit/f0e90409ab15023aa2fad6ea6f42e30669e6a365) Thanks [@intech](https://github.com/intech)! - feat: machine-readable `object` on `AmqpTopologyError` ([#202](https://github.com/Connectum-Framework/connectum/issues/202))
  
  - New `AmqpTopologyObject` discriminated union — `{ kind: 'exchange' | 'queue', name }` or `{ kind: 'binding', source, destination, destinationType, routingKey }` (a binding has no name of its own) — exposed as `AmqpTopologyError.object` and exported from the barrel.
  - Populated structurally at every broker declare/check/consume site (`applyTopology` check and assert modes per object, subscribe-path queue declaration/bindings/check-mode verification, consume failures), so CI drift checks and observability never parse broker-reply text. `object.kind` says *what* was being declared; *why* it failed stays with the error class and `cause`. One documented exception: the config-validation error for a malformed binding declaration (neither `queue` nor `exchange` set) carries no `object` — its destination is exactly the missing piece.
  - `AmqpTopologyError` constructor now takes an options-bag `{ cause?, object? }`. Construction stays bit-for-bit compatible: message-only instances install no own `cause`/`object` keys (pinned by unit tests), so spread clones and own-property log serializers see no new keys unless an object is actually supplied.

- [#218](https://github.com/Connectum-Framework/connectum/pull/218) [`24e73f6`](https://github.com/Connectum-Framework/connectum/commit/24e73f6533e317e9932011e0f867d2e256861f52) Thanks [@intech](https://github.com/intech)! - feat: `treatTopologyErrorAsFatal` — stop recovery on deterministic topology drift ([#201](https://github.com/Connectum-Framework/connectum/issues/201))
  
  - New opt-in top-level option: when topology drift makes recovery attempts fail deterministically (a checked queue/exchange deleted, an incompatible redeclare), the adapter stops the reconnect cycle on the first such failure instead of retrying forever — it reports `setup-failed` then the terminal `reconnect-failed` lifecycle event, and subsequent publishes fail fast with `AmqpConnectionError`.
  - The gate reads the AMQP reply code of the failure cause — `404` NOT_FOUND / `406` PRECONDITION_FAILED are deterministic; transient causes wrapped into `AmqpTopologyError` during a setup pass (`320` connection-forced, `541` internal-error, `405` resource-locked, mid-setup connection drops) stay in normal recovery. `instanceof AmqpTopologyError` alone is deliberately NOT the gate. The RabbitMQ cluster classic-queue outage 404 ("home node ... down or inaccessible") is explicitly excluded as transient.
  - The stop is deterministic and complete: the recovery cycle's stopped flag flips synchronously inside the `connect-failed` handler, before amqplib schedules the next retry; subscription records are cleared (consumers are dead; a later `connect()` starts from a clean slate — pinned by a reconnect-after-fatal integration test). A fatal classification racing the adapter's own `disconnect()` is suppressed (no terminal events after a graceful stop began).
  - A `subscribe()` parked in the recovering wrapper's waiter queue when the cycle dies now rejects with the typed `AmqpConnectionError` (was amqplib's plain `Error("Connection closed")`).
  - Scope: steady-state recovery only; boot-time drift remains `failFastOnInitialSetupError`'s job. Setting both covers boot and steady state; the remaining gap (broker unreachable at `connect()` with drift surfacing before the first successful connect) is covered by neither flag — it is closed by `recovery.initialConnectMaxRetries` ([#198](https://github.com/Connectum-Framework/connectum/issues/198)). Default `false` — behavior unchanged unless opted in.

- [#224](https://github.com/Connectum-Framework/connectum/pull/224) [`ddc9ec7`](https://github.com/Connectum-Framework/connectum/commit/ddc9ec7c19fab079573acbb51372b957a8eeb15b) Thanks [@intech](https://github.com/intech)! - feat: programmable `FakeAmqpAdapter` test double via `@connectum/events-amqp/testing` ([#203](https://github.com/Connectum-Framework/connectum/issues/203))
  
  - New subpath export `@connectum/events-amqp/testing` with `FakeAmqpAdapter` — model AMQP failure semantics in unit tests without a broker: FIFO publish outcomes (`control.nextPublish` with the real typed error classes, incl. `AmqpPublishTimeoutError` — the state-UNKNOWN outcome no real broker reproduces deterministically), deterministic connection lifecycle (`dropConnection`/`completeRecovery`/`exhaustRecovery`/`failSetup`/`block`), wildcard + competing-consumer delivery with a settlement result (`{ delivered, acked, nacked, requeued, failed }`), and a `published` record of bus-facing publishes.
  - Parity by construction and by pinning: lifecycle events go through the real adapter's dispatch (canonical union ordering, deprecated flat shim, exception isolation); the state machine mirrors the real adapter (`already connected` from live/recovering/retries-exhausted states; mid-recovery `subscribe()` parks and settles with the recovery outcome; `setup-failed`/fail-fast gate on `AmqpTopologyError` like the real probe); incoming envelope headers honored and stripped like the real consumer; handler rejections swallowed like the real nack-on-error path; `instanceof` holds across the subpath boundary (tsup `splitting: true` — shared error-class chunk, pinned by a dist-level test).
  - Runtime-pure: the subpath pulls neither `amqplib` nor `node:test` into the consumer graph (only `@connectum/events` + `node:crypto`).
  - Documented divergences: no timing simulation (recovery advances via explicit control calls); settlement is recorded, not broker-driven (re-deliver with `attempt + 1` to model redelivery); no wire-level envelope on `published`; report-and-proceed on a non-fail-fast startup setup failure.

### Patch Changes

- [#312](https://github.com/Connectum-Framework/connectum/pull/312) [`7e915d6`](https://github.com/Connectum-Framework/connectum/commit/7e915d65d7646dce8614caff4d53cfacdc9c79c5) Thanks [@intech](https://github.com/intech)! - Harden publish and connection lifecycle handling in `@connectum/events-amqp`:
  
  - `publish()` is accepted only on a usable connection. During `connect()` (including its startup probe) and after a connection loss it rejects with the typed `AmqpConnectionError` ("not connected") instead of a raw "Channel closed" from a dead channel; `publishRetry` re-checks before every attempt.
  - A `connect()` superseded by `disconnect()` now closes the connection it opened and rejects, so `connect()` → `disconnect()` → `connect()` no longer leaves an orphan connection on the broker. A second `connect()` while one is still running (without `disconnect()` in between) is refused with `AmqpConnectionError("AmqpAdapter: connect() already in progress")` instead of silently opening a second connection.
  - The setup of a superseded `connect()` (its publish channel, topology, consumers) no longer leaks into a newer `connect()`: a setup that finishes after `disconnect()` closes its own channel and leaves the publish channel, the live connection and the pending returns to the newer call. Before, a `connect()` → `disconnect()` → `connect()` sequence could end with `publish()` failing on the closed channel of the superseded call.
  - `publishTimeoutMs` of `NaN`, `Infinity`, `0`, a negative number or a fraction below 1 no longer makes every publish time out after about 1 ms: such a value is read as unset (30000 ms), and a value above 2147483647 is capped to it.
  - `publishRetry.maxRetries: -Infinity` now means a single attempt, like any other negative number; `NaN` means the default of 5.
  - Documentation: a consumer-side `decode` failure rejects the message without requeue and throws nothing (it never raised `AmqpSerializationError`); README describes a manual `connect()` after the broker closed the connection with `recovery: false`.

- [#254](https://github.com/Connectum-Framework/connectum/pull/254) [`d9f9fb4`](https://github.com/Connectum-Framework/connectum/commit/d9f9fb4f3360a906a0404a0feeda45d026a5cadd) Thanks [@intech](https://github.com/intech)! - Add configurable RESP2 and RESP3 Redis Streams support while preserving RESP2 as the backward-compatible default, and refresh the Redis, AMQP testcontainer, and authentication dependencies.

- [#214](https://github.com/Connectum-Framework/connectum/pull/214) [`e2b613b`](https://github.com/Connectum-Framework/connectum/commit/e2b613bad73024bf5b00c41717c063aac3665859) Thanks [@intech](https://github.com/intech)! - docs: recovery backoff tuning and publisher shutdown guidance
  
  - **events-amqp**: accurate reconnect-delay semantics in README and `AmqpRecoveryOptions` JSDoc — amqplib's strategy is symmetric jitter around the exponential base (not equal-jitter), and since amqplib 2.2.0 (the new minimum) the base is capped at `maxDelay / (1 + jitter)`, so a delay never exceeds `maxDelay`. Documented the exact full-jitter recipe: `jitter: 1`, `initialDelay: I/2`, `maxDelay: C` gives a delay uniform in `[0, min(I × factor^(n−1), C)]`.
  - **events**: new "Publishers and Shutdown" README section — `stop()` drains consumer handlers only; await-before-stop recipe for at-least-once producers; the stopping-gate limitation for publishes from draining handlers ([#212](https://github.com/Connectum-Framework/connectum/issues/212)); the planned opt-in `drainPublishTimeout` ([#196](https://github.com/Connectum-Framework/connectum/issues/196)).

- [#307](https://github.com/Connectum-Framework/connectum/pull/307) [`a8d8864`](https://github.com/Connectum-Framework/connectum/commit/a8d8864e979344e07a500351c88d6ae0a5fa355e) Thanks [@intech](https://github.com/intech)! - fix: a subscription without `group` works on RabbitMQ 4.3 and later
  
  - The private queue `{exchange}.sub-{uuid}` of a subscription without `group` is now exclusive to the subscriber's connection by default. RabbitMQ 4.3 refuses a queue that is neither durable nor exclusive (the `transient_nonexcl_queues` deprecated feature), so the subscription previously failed with a closed channel. The README already described the queue as exclusive.
  - `consumerOptions.exclusive` now defaults to `true` and is documented for what it controls: the exclusivity of that private queue. Set it to `false` only for brokers older than 4.3. Subscriptions with `group` are unaffected.

- [#304](https://github.com/Connectum-Framework/connectum/pull/304) [`bf69222`](https://github.com/Connectum-Framework/connectum/commit/bf6922290b84dda61e4503c1daf81966c7804f00) Thanks [@intech](https://github.com/intech)! - fix: a delivery is settled at most once — a handler that calls `ack()` or `nack(false)` and then throws no longer makes the adapter settle the same delivery again
  
  - Before: the adapter's fallback requeue after a rejected handler reached the broker for a delivery tag the handler had already settled. RabbitMQ answers that with `PRECONDITION_FAILED - unknown delivery tag` and closes the consumer channel, and the adapter reported nothing, so the consumer silently stopped receiving messages.
  - Now: the first settlement of a delivery wins (`ack()`, `nack()`, `nack(false)`, the requeue after a rejected handler, the reject after a `decode` failure). Every later settlement of the same delivery resolves without reaching the broker, without a lifecycle event. A handler that throws without settling is requeued as before.
  - `FakeAmqpAdapter` follows the same rule when it counts settlements in `control.deliver()`, and a bare `nack()` is counted as a requeue (only `nack(false)` is a reject), as in the real adapter.

- [#270](https://github.com/Connectum-Framework/connectum/pull/270) [`cfc1a21`](https://github.com/Connectum-Framework/connectum/commit/cfc1a216f48fca6a5efa959e628ef0b2ccea313f) Thanks [@intech](https://github.com/intech)! - fix: amqplib 2.2.0 baseline — bounded delays and a clean terminal state after recovery gives up
  
  - **amqplib floor raised to `^2.2.0`.** Consumers of the previous `^2.0.1` range already resolved 2.2.0; the package is now built and tested against it. amqplib 2.2.0 caps its recovery base at `maxDelay / (1 + jitter)`, so a reconnect delay never exceeds `maxDelay` (default saturation: 20–30 s, previously 24–36 s), and channel operations reject instead of waiting forever once recovery has given up.
  - **Adapter-owned delays follow the same formula.** The bounded initial connect (`initialConnectMaxRetries`) and `publishRetry` now compute their backoff exactly like amqplib 2.2.0, so they no longer overshoot `maxDelay` either.
  - **Recovery give-up is a clean terminal state.** When a finite `maxRetries` is exhausted (terminal `reconnect-failed`), the adapter now drops the dead connection, its publish channel and its subscription records before reporting the event — the same teardown as the fatal topology stop. Previously it kept the dead connection: `subscribe()` hung (amqplib 2.0.1) or rejected with a raw socket error (2.2.0), a `publishRetry` publish spent its whole retry budget, and `connect()` refused with "already connected". Now `subscribe()` and `publish()` reject at once with `AmqpConnectionError` ("not connected"), and a later `connect()` starts from a clean slate without the old subscriptions — re-subscribe explicitly.
  - **A subscription whose cycle dies while it is being set up is dropped.** `subscribe()` rejects with `AmqpConnectionError` instead of recording a subscription that the next `connect()` would silently replay; a `subscribe()` already waiting for a channel when recovery gives up also rejects typed instead of surfacing amqplib's raw socket error.
  - **Typed initial-connect failure with a finite `maxRetries`.** When amqplib's own initial loop gives up (finite `maxRetries`, no `initialConnectMaxRetries`), `connect()` now rejects with `AmqpConnectionError` carrying the last connection error as `cause`, instead of the raw error (e.g. `ECONNREFUSED`). `recovery: false` is unchanged.
  - **`FakeAmqpAdapter` (`@connectum/events-amqp/testing`) follows the new terminal state:** after `control.exhaustRecovery()` a fresh `connect()` is accepted (it used to throw "already connected" until `disconnect()`), and the old subscriptions are dropped instead of only deactivated.

## 1.2.0

### Minor Changes

- [#205](https://github.com/Connectum-Framework/connectum/pull/205) [`694fda0`](https://github.com/Connectum-Framework/connectum/commit/694fda0dc99d7668dbb3147aa4ada742e17c7c0d) Thanks [@intech](https://github.com/intech)! - Add opt-in `failFastOnInitialSetupError` and an `onSetupFailed` lifecycle callback.

  When recovery is enabled, a deterministic setup/topology error on the **first** connect can now reject `connect()` with the typed `AmqpTopologyError` instead of hanging forever in amqplib's infinite recovery loop (under the default `maxRetries: Infinity`, amqplib never rejects the initial connect, so a permanent topology error previously hung `connect()`/`bus.start()` silently). A transient broker-unreachable at startup still blocks-and-retries. `onSetupFailed(error, { initial, attempt })` surfaces setup/topology failures on the initial validation probe and on every reconnect — distinct from a mere broker outage. Default behavior is unchanged (both are opt-in). Also corrects the `topologyMode: "check"` documentation, which previously promised unconditional "fail fast".

### Patch Changes

- [#205](https://github.com/Connectum-Framework/connectum/pull/205) [`694fda0`](https://github.com/Connectum-Framework/connectum/commit/694fda0dc99d7668dbb3147aa4ada742e17c7c0d) Thanks [@intech](https://github.com/intech)! - Harden the connection-loss-vs-nack classification of in-flight publishes. A per-confirm-channel `close` flag (set via `prependListener`, before amqplib drains outstanding confirms) is now the primary structural signal for classifying a failed publish confirm as `AmqpConnectionError` vs `AmqpPublishNackError`; the amqplib error-text match is retained only as a defense-in-depth fallback. This makes the at-least-once republish decision robust to upstream error-text drift. No public API change, and genuine broker nacks on a live channel still classify as `AmqpPublishNackError`.

- [#205](https://github.com/Connectum-Framework/connectum/pull/205) [`694fda0`](https://github.com/Connectum-Framework/connectum/commit/694fda0dc99d7668dbb3147aa4ada742e17c7c0d) Thanks [@intech](https://github.com/intech)! - Fix `onReconnecting` firing twice per failed reconnect cycle. amqplib emits both `connect-failed` and `reconnect-scheduled` for a single failed attempt; the adapter now derives `onReconnecting` solely from `reconnect-scheduled`, so it fires exactly once per scheduled retry. The terminal, retries-exhausted case remains `onReconnectFailed`. Removes the undocumented `{ attempt: -1 }` sentinel that double-counted reconnect metrics.

- [#208](https://github.com/Connectum-Framework/connectum/pull/208) [`3a846c4`](https://github.com/Connectum-Framework/connectum/commit/3a846c487517313cf015472b5a4b2de764bd41fc) Thanks [@intech](https://github.com/intech)! - docs(events-amqp): document republish-safety and recovery semantics

  - The Error Taxonomy now publishes an authoritative **Message state** / **Republish (at-least-once)** matrix (README + the errors `@module` JSDoc) so at-least-once producers no longer infer retry-safety from class names. Connection loss is classified structurally and is never misreported as a nack; `AmqpSerializationError`/`AmqpUnroutableError`/`AmqpTopologyError` are documented as deterministic (do-not-republish).
  - Recovery docs clarify that `maxRetries` governs **both** the initial connect and every steady-state recovery series (counter reset on success), with the brittleness of a finite value, and that the effective reconnect delay can overshoot `maxDelay` because of equal-jitter.
  - `topologyMode: "check"` and the recovery JSDoc are finalized: fail-fast applies only with `recovery: false` or `failFastOnInitialSetupError: true`; under the default recovery a permanent setup error is surfaced via `onSetupFailed` / `onReconnecting`.

## 1.1.0

### Minor Changes

- [#185](https://github.com/Connectum-Framework/connectum/pull/185) [`cc5a42c`](https://github.com/Connectum-Framework/connectum/commit/cc5a42cf7325889009a372e96554a749c6cf0887) Thanks [@intech](https://github.com/intech)! - Add `publisherOptions.externalContract` for publishing against an external (non-EventBus) AMQP/AsyncAPI contract. When set, the adapter suppresses the EventBus envelope so the wire frame carries only contract-specified properties — no `x-event-id` / `x-published-at` headers, no auto-populated `messageId` / `timestamp`, and (for `mandatory` publishes) single-flight correlation so no `x-connectum-publish-id` header reaches the wire (`correlationHeader` is ignored in this mode). The frame then carries only `contentType`, `persistent`/deliveryMode, `mandatory`, and the headers supplied via `PublishOptions.metadata`.

  This closes the gap where `correlationHeader: false` was documented as yielding a "clean wire" but the envelope still shipped ([#161](https://github.com/Connectum-Framework/connectum/issues/161)). Default (EventBus) behavior is unchanged: the envelope is stamped on publish and stripped on delivery. Verified with a raw amqplib consumer against a real broker. A caller-controlled `messageId` / `timestamp` (needs a cross-package `PublishOptions` field) remains a documented follow-up.

- [#186](https://github.com/Connectum-Framework/connectum/pull/186) [`ac41deb`](https://github.com/Connectum-Framework/connectum/commit/ac41deb0641ed4027b53fa7bc82a23312cfccdaa) Thanks [@intech](https://github.com/intech)! - Add `PublishOptions.messageId` and `PublishOptions.timestamp` (Unix epoch seconds) so a caller can set the message identity an external contract requires. Adapters honor them where supported and ignore them otherwise; `@connectum/events-amqp` maps them to the AMQP `messageId` / `timestamp` properties.

  This completes the external-contract publish path ([#161](https://github.com/Connectum-Framework/connectum/issues/161)): in `externalContract` mode the adapter auto-generates nothing, so a caller-supplied `messageId` / `timestamp` is the way to populate those wire properties when the contract demands them. A supplied value is used as-is in any mode; auto-generation still applies only in non-external mode when the caller omits them.

## 1.0.0

### Major Changes

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

### Minor Changes

- [#65](https://github.com/Connectum-Framework/connectum/pull/65) [`4f2705b`](https://github.com/Connectum-Framework/connectum/commit/4f2705bbd8a86eb57419baf81c292da9f5e8b841) Thanks [@intech](https://github.com/intech)! - Add @connectum/events-amqp — AMQP 0-9-1 / RabbitMQ adapter for EventBus

  New package providing AMQP adapter for @connectum/events:

  - RabbitMQ and LavinMQ compatibility
  - Topic exchange for wildcard routing
  - Durable queues with competing consumers
  - Message headers for metadata propagation
  - Dead letter exchange integration with DLQ middleware
  - Automatic client identification via connection name

- [#140](https://github.com/Connectum-Framework/connectum/pull/140) [`cd03cb3`](https://github.com/Connectum-Framework/connectum/commit/cd03cb35d66cc5109fc0853089ab659d30c73ccd) Thanks [@intech](https://github.com/intech)! - External AMQP contracts, automatic recovery, and reliable per-message publishing.

  The adapter can now implement an externally agreed AMQP contract (AsyncAPI-style) and survive broker outages:

  - **Serialization**: `serialization: { contentType, encode, decode }` — set the message `contentType` (e.g. `application/json` for JSON contracts; default stays `application/protobuf`) and optionally transcode the wire body.
  - **Explicit topology**: `topology: { exchanges, queues, bindings }` with arbitrary external names and raw AMQP `arguments` (incl. `x-dead-letter-exchange`), exchange-to-exchange bindings, plus `topologyMode: "assert" | "check" | "skip"` for app-owned topology with fail-fast existence checks.
  - **queueOverrides**: attach a consumer group to an externally named queue instead of `${exchange}.${group}`.
  - **Automatic recovery** (amqplib v2 native opt-in recovery, enabled by default): reconnect with backoff/jitter, re-created channels, re-applied topology, replayed subscriptions. `lifecycle` callbacks (`onConnected` / `onDisconnected` / `onReconnecting` / `onReconnectFailed`) replace console-only error reporting. With recovery enabled `connect()` waits for the broker (docker-compose friendly); `recovery: false` restores fail-fast.
  - **Reliable publishing**: every `publish()` resolves on its own broker ack and rejects with a typed error — `AmqpUnroutableError` (mandatory + `basic.return`, correlated via a private `x-connectum-publish-id` header; opt-out `correlationHeader: false` switches to single-flight), `AmqpPublishNackError`, `AmqpPublishTimeoutError` (`publishTimeoutMs`, default 30 s), `AmqpConnectionError`, `AmqpTopologyError`, `AmqpSerializationError`.

  Deprecations / behavioral notes:

  - The `sync` publish flag is now a no-op in this adapter — confirms are always per-message.
  - `mandatory: true` publishes stamp the `x-connectum-publish-id` header on the wire (visible to external consumers; documented; opt-out available).
  - Dependency: `amqplib` upgraded `^1.0.3` → `^2.0.1`.

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

- Updated dependencies [[`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`d42e2bd`](https://github.com/Connectum-Framework/connectum/commit/d42e2bdc7229635214abc63553b39d9dee8985b2), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`cd03cb3`](https://github.com/Connectum-Framework/connectum/commit/cd03cb35d66cc5109fc0853089ab659d30c73ccd), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f)]:
  - @connectum/events@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/events@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Updated dependencies [[`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4), [`7f23c41`](https://github.com/Connectum-Framework/connectum/commit/7f23c4120680a57e084a03de0a6da978c31b65f4)]:
  - @connectum/events@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Updated dependencies []:
  - @connectum/events@1.0.0-rc.9

## 1.0.0-rc.8

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`d42e2bd`](https://github.com/Connectum-Framework/connectum/commit/d42e2bdc7229635214abc63553b39d9dee8985b2)]:
  - @connectum/events@1.0.0-rc.8

## 1.0.0-rc.7

### Minor Changes

- [#65](https://github.com/Connectum-Framework/connectum/pull/65) [`4f2705b`](https://github.com/Connectum-Framework/connectum/commit/4f2705bbd8a86eb57419baf81c292da9f5e8b841) Thanks [@intech](https://github.com/intech)! - Add @connectum/events-amqp — AMQP 0-9-1 / RabbitMQ adapter for EventBus

  New package providing AMQP adapter for @connectum/events:

  - RabbitMQ and LavinMQ compatibility
  - Topic exchange for wildcard routing
  - Durable queues with competing consumers
  - Message headers for metadata propagation
  - Dead letter exchange integration with DLQ middleware
  - Automatic client identification via connection name

### Patch Changes

- Updated dependencies [[`4d48e1c`](https://github.com/Connectum-Framework/connectum/commit/4d48e1c8ef9877fbc572a421bb99c0704f9fbbca)]:
  - @connectum/events@1.0.0-rc.7

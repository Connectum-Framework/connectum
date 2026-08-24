# @connectum/events-amqp

## 1.3.0

### Minor Changes

- [#222](https://github.com/Connectum-Framework/connectum/pull/222) [`3a76225`](https://github.com/Connectum-Framework/connectum/commit/3a76225e8ec826bd859d4a0acbdc7dff0d3718bb) Thanks [@intech](https://github.com/intech)! - feat: `publishRetry` — opt-in bounded publish retry for connection-class outcomes ([#195](https://github.com/Connectum-Framework/connectum/issues/195))
  
  - New top-level `publishRetry: boolean | AmqpPublishRetryOptions`: a `publish()` failing with `AmqpConnectionError` (publish during a recovery window; in-flight confirm lost to a drop) retries in place — a short broker blip becomes a transparent delay instead of an instant rejection. Backoff mirrors the recovery formula; `maxRetries` defaults to a bounded `5`. `AmqpPublishTimeoutError` joins only via `retryOnTimeout: true`.
  - The auto-retry boundary is the exported **`isAutoRetriablePublishError`** — deliberately narrower than the at-least-once republish matrix (a broker nack is republish-safe by policy but never auto-retried inline; deterministic outcomes never retry). Docs distinguish the two boundaries explicitly.
  - At-least-once framing documented honestly: a retry after an in-flight confirm loss may duplicate; `x-event-id`/`messageId` stay stable across attempts (incl. `externalContract`) as the consumer-side dedup anchor.
  - Shutdown-aware and drain-covered: the loop aborts promptly on `disconnect()` (interruptible backoff) and lives inside the `adapter.publish()` promise, so the bus-level `drainPublishTimeout` covers retries automatically. Under single-flight correlation, retries hold the chain (ordering preserved; head-of-line blocking documented). The publish channel is re-resolved per attempt.
  - Default off — publish behavior unchanged unless opted in.

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
  - Backoff replicates amqplib's steady-state formula exactly (same knobs, same cap-before-jitter semantics; pinned by unit tests against the documented formula). `failFastOnInitialSetupError` still short-circuits deterministic topology errors immediately; the backoff sleep is interruptible by `disconnect()`.
  - Upstream native support remains tracked in amqp-node/amqplib#856 (this implementation becomes a passthrough if it lands).

- [#217](https://github.com/Connectum-Framework/connectum/pull/217) [`f0e9040`](https://github.com/Connectum-Framework/connectum/commit/f0e90409ab15023aa2fad6ea6f42e30669e6a365) Thanks [@intech](https://github.com/intech)! - feat: machine-readable `object` on `AmqpTopologyError` ([#202](https://github.com/Connectum-Framework/connectum/issues/202))
  
  - New `AmqpTopologyObject` discriminated union — `{ kind: 'exchange' | 'queue', name }` or `{ kind: 'binding', source, destination, destinationType, routingKey }` (a binding has no name of its own) — exposed as `AmqpTopologyError.object` and exported from the barrel.
  - Populated structurally at every broker declare/check/consume site (`applyTopology` check and assert modes per object, subscribe-path queue declaration/bindings/check-mode verification, consume failures), so CI drift checks and observability never parse broker-reply text. `object.kind` says *what* was being declared; *why* it failed stays with the error class and `cause`. One documented exception: the config-validation error for a malformed binding declaration (neither `queue` nor `exchange` set) carries no `object` — its destination is exactly the missing piece.
  - `AmqpTopologyError` constructor now takes an options-bag `{ cause?, object? }`. Construction stays bit-for-bit compatible: message-only instances install no own `cause`/`object` keys (pinned by unit tests), so spread clones and own-property log serializers see no new keys unless an object is actually supplied.

- [#218](https://github.com/Connectum-Framework/connectum/pull/218) [`24e73f6`](https://github.com/Connectum-Framework/connectum/commit/24e73f6533e317e9932011e0f867d2e256861f52) Thanks [@intech](https://github.com/intech)! - feat: `treatTopologyErrorAsFatal` — stop recovery on deterministic topology drift ([#201](https://github.com/Connectum-Framework/connectum/issues/201))
  
  - New opt-in top-level option: when topology drift makes recovery attempts fail deterministically (a checked queue/exchange deleted, an incompatible redeclare), the adapter stops the reconnect cycle on the first such failure instead of retrying forever — it reports `setup-failed` then the terminal `reconnect-failed` lifecycle event, and subsequent publishes fail fast with `AmqpConnectionError`.
  - The gate reads the AMQP reply code of the failure cause — `404` NOT_FOUND / `406` PRECONDITION_FAILED are deterministic; transient causes wrapped into `AmqpTopologyError` during a setup pass (`320` connection-forced, `541` internal-error, `405` resource-locked, mid-setup connection drops) stay in normal recovery. `instanceof AmqpTopologyError` alone is deliberately NOT the gate. The RabbitMQ cluster classic-queue outage 404 ("home node ... down or inaccessible") is explicitly excluded as transient.
  - The stop is deterministic and complete: the recovery cycle's stopped flag flips synchronously inside the `connect-failed` handler, before amqplib schedules the next retry; subscription records are cleared (consumers are dead; a later `connect()` starts from a clean slate — pinned by a reconnect-after-fatal integration test). A fatal classification racing the adapter's own `disconnect()` is suppressed (no terminal events after a graceful stop began).
  - A `subscribe()` parked in the recovering wrapper's waiter queue when the cycle dies now rejects with the typed `AmqpConnectionError` (was amqplib's plain `Error("Connection closed")`).
  - Scope: steady-state recovery only; boot-time drift remains `failFastOnInitialSetupError`'s job. Setting both covers boot and steady state; the remaining gap (broker unreachable at `connect()` with drift surfacing before the first successful connect) is covered by neither flag until [#198](https://github.com/Connectum-Framework/connectum/issues/198). Default `false` — behavior unchanged unless opted in.

- [#224](https://github.com/Connectum-Framework/connectum/pull/224) [`ddc9ec7`](https://github.com/Connectum-Framework/connectum/commit/ddc9ec7c19fab079573acbb51372b957a8eeb15b) Thanks [@intech](https://github.com/intech)! - feat: programmable `FakeAmqpAdapter` test double via `@connectum/events-amqp/testing` ([#203](https://github.com/Connectum-Framework/connectum/issues/203))
  
  - New subpath export `@connectum/events-amqp/testing` with `FakeAmqpAdapter` — model AMQP failure semantics in unit tests without a broker: FIFO publish outcomes (`control.nextPublish` with the real typed error classes, incl. `AmqpPublishTimeoutError` — the state-UNKNOWN outcome no real broker reproduces deterministically), deterministic connection lifecycle (`dropConnection`/`completeRecovery`/`exhaustRecovery`/`failSetup`/`block`), wildcard + competing-consumer delivery with a settlement result (`{ delivered, acked, nacked, requeued, failed }`), and a `published` record of bus-facing publishes.
  - Parity by construction and by pinning: lifecycle events go through the real adapter's dispatch (canonical union ordering, deprecated flat shim, exception isolation); the state machine mirrors the real adapter (`already connected` from live/recovering/retries-exhausted states; mid-recovery `subscribe()` parks and settles with the recovery outcome; `setup-failed`/fail-fast gate on `AmqpTopologyError` like the real probe); incoming envelope headers honored and stripped like the real consumer; handler rejections swallowed like the real nack-on-error path; `instanceof` holds across the subpath boundary (tsup `splitting: true` — shared error-class chunk, pinned by a dist-level test).
  - Runtime-pure: the subpath pulls neither `amqplib` nor `node:test` into the consumer graph (only `@connectum/events` + `node:crypto`).
  - Documented divergences: no timing simulation (recovery advances via explicit control calls); settlement is recorded, not broker-driven (re-deliver with `attempt + 1` to model redelivery); no wire-level envelope on `published`; report-and-proceed on a non-fail-fast startup setup failure.

### Patch Changes

- [#254](https://github.com/Connectum-Framework/connectum/pull/254) [`d9f9fb4`](https://github.com/Connectum-Framework/connectum/commit/d9f9fb4f3360a906a0404a0feeda45d026a5cadd) Thanks [@intech](https://github.com/intech)! - Add configurable RESP2 and RESP3 Redis Streams support while preserving RESP2 as the backward-compatible default, and refresh the Redis, AMQP testcontainer, and authentication dependencies.

- [#214](https://github.com/Connectum-Framework/connectum/pull/214) [`e2b613b`](https://github.com/Connectum-Framework/connectum/commit/e2b613bad73024bf5b00c41717c063aac3665859) Thanks [@intech](https://github.com/intech)! - docs: recovery backoff tuning and publisher shutdown guidance
  
  - **events-amqp**: accurate reconnect-delay semantics in README and `AmqpRecoveryOptions` JSDoc — the amqplib v2 strategy is symmetric jitter around the exponential base (not equal-jitter), with the cap applied before jitter (hence the overshoot above `maxDelay`). Documented the exact full-jitter workaround (`jitter: 1` + halved `initialDelay`/`maxDelay` → delay uniform in `[0, intended cap]`, verified against amqplib 2.0.1) with a fragility caveat and upstream tracking links (amqp-node/amqplib#855, amqp-node/amqplib#856).
  - **events**: new "Publishers and Shutdown" README section — `stop()` drains consumer handlers only; await-before-stop recipe for at-least-once producers; the stopping-gate limitation for publishes from draining handlers ([#212](https://github.com/Connectum-Framework/connectum/issues/212)); the planned opt-in `drainPublishTimeout` ([#196](https://github.com/Connectum-Framework/connectum/issues/196)).

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

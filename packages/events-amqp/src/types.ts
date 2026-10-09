/**
 * Configuration types for the AMQP/RabbitMQ adapter.
 *
 * @module types
 */

/**
 * Options for creating an AMQP/RabbitMQ adapter.
 */
export interface AmqpAdapterOptions {
    /**
     * AMQP connection URL.
     *
     * @example "amqp://guest:guest@localhost:5672"
     */
    readonly url: string;

    /**
     * Socket options passed to `amqplib.connect()`.
     */
    readonly socketOptions?: Record<string, unknown>;

    /**
     * Exchange name for publishing and subscribing.
     *
     * @default "connectum.events"
     */
    readonly exchange?: string;

    /**
     * Exchange type. The EventBus selects handlers by matching each delivered
     * event type against the subscription patterns and acknowledges events
     * without a handler; the adapter only guarantees that the broker delivers
     * every wanted event, never a subset of them.
     *
     * - `"topic"`: patterns are translated for the broker (`*` is one segment,
     *   a terminal `>` becomes `*.#`, one or more trailing segments). A
     *   complete `#` segment is rejected, since RabbitMQ would read it as a
     *   wildcard while the EventBus reads it as text.
     * - `"direct"`: the queue is bound to the exact routing key. With
     *   `topologyMode: "assert"` a subscription using a complete `*` or `>` is
     *   rejected, because the literal binding would never receive a message.
     *   With `"check"` or `"skip"` the adapter binds nothing, the operator's
     *   bindings decide delivery and the pattern only selects handlers.
     * - `"fanout"`: the routing key is ignored, so the queue receives every
     *   message whatever the pattern; the EventBus dispatches only matching
     *   handlers and acknowledges the rest, while a handler passed straight to
     *   `adapter.subscribe()` sees every message.
     * - `"headers"`: the adapter publishes no header carrying the event type,
     *   so it cannot derive header bindings from a pattern. In `"assert"` mode
     *   it binds the queue without arguments, which matches every message (the
     *   behavior of `"fanout"`), unless `topology.bindings` binds that queue
     *   to the exchange: then those declared bindings alone decide what the
     *   queue receives and the adapter adds none. A binding created outside the
     *   topology is not seen, and the argument-less binding would also deliver
     *   what it excludes; use `"check"` or `"skip"` for such bindings, or
     *   declare them in the topology.
     *
     * @default "topic"
     */
    readonly exchangeType?: "topic" | "direct" | "fanout" | "headers";

    /**
     * Exchange assertion options.
     */
    readonly exchangeOptions?: AmqpExchangeOptions;

    /**
     * Default queue assertion options.
     */
    readonly queueOptions?: AmqpQueueOptions;

    /**
     * Consumer options.
     */
    readonly consumerOptions?: AmqpConsumerOptions;

    /**
     * Publisher options.
     */
    readonly publisherOptions?: AmqpPublisherOptions;

    /**
     * Message serialization metadata and optional wire transcoding.
     *
     * The adapter receives payloads as bytes (the EventBus serializes
     * protobuf upstream); this option controls the AMQP `contentType`
     * property and lets an application transcode the wire body — e.g. when
     * the application serializes JSON itself and publishes through the
     * adapter directly against an external AsyncAPI contract.
     */
    readonly serialization?: AmqpSerializationOptions;

    /**
     * Explicit topology to declare on connect (and re-declare after
     * recovery): exchanges, queues with arbitrary external names and raw
     * arguments (e.g. `x-dead-letter-exchange`), and bindings — including
     * exchange-to-exchange.
     */
    readonly topology?: AmqpTopology;

    /**
     * How topology is established:
     * - `"assert"` (default) — declare idempotently (assertExchange/assertQueue/bind);
     * - `"check"` — existence-only verification (checkExchange/checkQueue). A
     *   missing object raises AmqpTopologyError, which fails `connect()` fast
     *   ONLY with `recovery: false` or `failFastOnInitialSetupError: true`; under
     *   the default recovery a first-connect check failure otherwise enters the
     *   (infinite) recovery loop and is surfaced via `onSetupFailed` /
     *   `onReconnecting` rather than rejecting `connect()`. AMQP offers no passive
     *   introspection: argument equivalence and binding presence are NOT
     *   verifiable in this mode (a conflicting redeclare elsewhere is
     *   PRECONDITION_FAILED 406);
     * - `"skip"` — no topology operations at all; the application owns topology.
     *
     * @default "assert"
     */
    readonly topologyMode?: AmqpTopologyMode;

    /**
     * Map a consumer group name to an externally-named queue.
     *
     * By default a group consumes from `${exchange}.${group}`. An override
     * lets a subscription attach to a queue from an external contract
     * (with its own arguments) instead.
     */
    readonly queueOverrides?: Record<string, AmqpQueueOverride>;

    /**
     * Automatic connection recovery (delegated to amqplib's opt-in
     * recovery). Enabled by default; pass `false` to restore
     * no-reconnect behavior.
     *
     * On every (re)connect the adapter re-creates its channels, re-applies
     * topology (per `topologyMode`), and replays active subscriptions.
     * In-flight publishes at the moment of a connection loss reject with
     * `AmqpConnectionError`.
     *
     * With recovery enabled the adapter also restores a consumer the broker
     * ended while the connection stayed up (queue deleted, consumer cancelled,
     * channel closed): `consumer-lost`, then `consumer-restored` or
     * `consumer-restore-failed`. Attempts wait the same delay formula (the
     * numeric knobs; the defaults when `backoff` is set) and have no limit
     * except a failure that cannot heal. With `false` the loss is reported
     * with `willRestore: false` and the consumer stays dead.
     *
     * `maxRetries` governs BOTH the initial connect and steady-state recovery
     * (counter reset on success); under the default `Infinity`, `connect()`
     * blocks until the broker is reachable rather than failing fast (see
     * {@link AmqpAdapterOptions.failFastOnInitialSetupError} to fail fast on a
     * deterministic startup misconfiguration). See {@link AmqpRecoveryOptions}
     * for the retry-budget scope and the delay bounds. With a finite
     * `maxRetries`, a broker still unreachable when the initial connect has
     * used its budget rejects `connect()` with a typed `AmqpConnectionError`
     * whose `cause` is the last connection error. Once a finite budget is
     * exhausted, recovery is over for good — see the terminal
     * `reconnect-failed` in {@link AmqpLifecycleEvent}.
     *
     * @default true (amqplib defaults: 100ms initial, ×2, 30s cap, jitter 0.2, infinite retries)
     */
    readonly recovery?: boolean | AmqpRecoveryOptions;

    /**
     * Fail fast on a DETERMINISTIC setup/topology error on the FIRST connect,
     * instead of entering amqplib's infinite recovery loop.
     *
     * amqplib's opt-in recovery resolves `connect()` only after its setup hook
     * succeeds, and rejects only once `maxRetries` is exhausted (default
     * `Infinity`). A permanent topology error on the first connect under the
     * default recovery therefore HANGS `connect()` forever, with no thrown error
     * and — because the lifecycle listeners attach only after that never-returning
     * await — no callback. When this flag is `true` (and recovery is enabled), a
     * topology error of the initial connect rejects `connect()` with the typed
     * `AmqpTopologyError` / `AmqpConnectionError`. Without
     * {@link AmqpRecoveryOptions.initialConnectMaxRetries} the adapter first
     * validates topology against a throwaway non-recovering connection (the
     * startup probe); with it, every initial attempt runs the full setup and
     * the first setup error stops the initial connect.
     *
     * Only deterministic setup/topology errors fail fast. A transient
     * broker-unreachable at startup is NOT a fail-fast condition — it falls
     * through to normal recovery (block-until-broker, or the initial connect
     * budget). SUBSEQUENT reconnects always keep infinite-recovery behavior.
     *
     * No-op with `recovery: false` (that path already fails fast on setup).
     * Without `initialConnectMaxRetries`, enabling this — or supplying
     * {@link AmqpLifecycleCallbacks.onLifecycle} or
     * {@link AmqpLifecycleCallbacks.onSetupFailed} — adds one extra
     * short-lived connection plus a topology validation pass at startup for
     * the probe (recovery must be enabled; with `recovery: false` no probe
     * runs and no `setup-failed` event is delivered).
     *
     * @default false
     */
    readonly failFastOnInitialSetupError?: boolean;

    /**
     * Treat DETERMINISTIC topology drift during steady-state recovery as
     * fatal: stop the reconnect cycle instead of retrying forever against a
     * misconfigured broker.
     *
     * Under the default `maxRetries: Infinity`, a queue/exchange deleted or
     * redeclared incompatibly while the adapter is reconnecting makes every
     * recovery attempt fail deterministically — the adapter would retry
     * forever, reporting `setup-failed` on each attempt but never giving up.
     * With this flag the adapter stops the cycle on the first such failure
     * and reports the terminal `reconnect-failed` lifecycle event (after the
     * `setup-failed` event for the same attempt); subsequent publishes fail
     * fast with `AmqpConnectionError`.
     *
     * The gate is the broker reply of the failure cause (its AMQP reply code
     * AND reply text) — NOT the error class: transient causes wrapped into
     * `AmqpTopologyError` during a setup pass (broker restarting `320`,
     * internal error `541`, resource locked `405`, a mid-setup connection
     * drop) stay in normal recovery. Only replies that name a condition which
     * cannot heal without a configuration or topology change are fatal:
     * - `404` "no queue" / "no exchange" (the object is missing);
     * - `406` "inequivalent arg" (redeclare with different arguments),
     *   "invalid arg", "unknown exchange type" / "invalid exchange type".
     *
     * Everything else stays in recovery, including a `404` that RabbitMQ
     * raises for a self-healing queue condition (home node down or
     * inaccessible, queue process crashed or stopped by its supervisor,
     * timeout, leader stopping or being demoted), a `406` such as "exchange
     * limit reached" (clears when exchanges are removed), and a reply that
     * carries no text. A RabbitMQ release that rewords a message therefore
     * degrades to "keep retrying" (visible through `reconnecting` /
     * `setup-failed`), never to a silent permanent stop.
     *
     * A fatal stop is quiet: no exception reaches application code. It is
     * observable only through `lifecycle.onLifecycle` (`reconnect-failed`) or
     * `lifecycle.onReconnectFailed`, and after it the adapter stays down until
     * the application starts the bus again — wire one of those callbacks and
     * restart from there.
     *
     * After the fatal stop the adapter is fully torn down: consumers are dead
     * (subscription records are cleared, mirroring `disconnect()`), publishes
     * fail fast, and a later `connect()` starts from a clean slate —
     * re-subscribe explicitly.
     *
     * Scope: steady-state recovery only. Boot-time drift is the startup
     * probe's job — see {@link failFastOnInitialSetupError}. Setting both
     * covers boot and steady state; the remaining window — broker unreachable
     * at `connect()` time with drift surfacing before the first successful
     * connect — is closed by
     * {@link AmqpRecoveryOptions.initialConnectMaxRetries} (since 1.3.0),
     * which reports those failures per attempt and rejects on exhaustion.
     *
     * @default false
     */
    readonly treatTopologyErrorAsFatal?: boolean;

    /**
     * Opt-in bounded publish retry for CONNECTION-CLASS outcomes (since 1.3.0).
     *
     * When enabled, a `publish()` that fails with `AmqpConnectionError` —
     * publishing during a recovery window, or an in-flight confirm lost to a
     * connection drop — is retried in place (the caller's promise stays
     * pending) instead of rejecting immediately: a short broker blip becomes
     * a transparent delay. `true` = defaults; an object tunes the budget.
     *
     * The retry boundary is {@link isAutoRetriablePublishError} — deliberately
     * NARROWER than the at-least-once republish matrix in the error taxonomy:
     * a broker `nack` is republish-safe by policy but is NOT auto-retried
     * inline (it is an explicit broker refusal, e.g. an over-capacity queue —
     * hammering it in a tight loop helps nobody). `AmqpPublishTimeoutError`
     * joins the boundary only with `retryOnTimeout: true`.
     *
     * Semantics — read before enabling:
     * - **At-least-once, full stop.** A retried publish whose previous attempt
     *   was lost IN FLIGHT (confirm never arrived: state UNKNOWN) may
     *   duplicate on the broker. `x-event-id` / `messageId` stay STABLE across
     *   attempts (also with `externalContract` — a caller-supplied id is
     *   reused as-is), so consumer-side dedup keys on them.
     * - **Worst-case latency**: each attempt is bounded by `publishTimeoutMs`
     *   (default 30s), so `maxRetries: 5` can hold a single `publish()` for
     *   several minutes worst-case — far beyond typical 30s RPC timeouts.
     *   There is deliberately no second overall-deadline knob: bound the
     *   budget via `maxRetries`/`publishTimeoutMs`.
     * - **Shutdown-aware**: the loop aborts on `disconnect()` (throws the last
     *   connection error) and, living inside the `adapter.publish()` promise,
     *   is automatically covered by the bus-level `drainPublishTimeout`.
     * - **Single-flight** (`mandatory: true` with `correlationHeader: false`;
     *   `externalContract` forces the latter but single-flight still requires
     *   `mandatory`): retries hold the chain — ordering is preserved at the
     *   cost of head-of-line blocking during backoff. In this headerless mode
     *   a late `basic.return` from an abandoned timed-out attempt may mark the
     *   current one (correlation is attempt-agnostic without the header) —
     *   prefer the default header correlation when combining `mandatory` with
     *   `retryOnTimeout`.
     * - **A broker-closed publish channel is not retried**: when the broker
     *   closes the publish CHANNEL with a reply code of any kind — `404` (a
     *   publish to a missing exchange under `topologyMode: "skip"`), `403`
     *   (a publish to an internal exchange), `406`, `541`, … — and that
     *   channel is still the current one, the publish surfaces immediately
     *   with the broker reply as `cause`, without `onRetry` or backoff. The
     *   connection stays up and recovery only recreates the channel when the
     *   connection itself drops, so retrying cannot heal. If recovery has
     *   already replaced the channel, retrying continues normally.
     * - **`maxRetries: Infinity`** makes `publish()` wait until recovery heals
     *   the connection or `disconnect()` is called. A channel-only close with
     *   a reply code is not part of that wait (see the previous item).
     *
     * - **No retry against a dead cycle**: once recovery has given up
     *   (terminal `reconnect-failed`) or `recovery: false` lost its
     *   connection, nothing can heal the publish, so it rejects at once
     *   without spending the budget.
     *
     * Backoff mirrors the recovery formula (same knob names and semantics; a
     * delay never exceeds `maxDelay`), but the DEFAULT budget differs:
     * `maxRetries` here defaults to **5** (bounded), not `Infinity`.
     *
     * @default undefined (disabled — behavior unchanged)
     */
    readonly publishRetry?: boolean | AmqpPublishRetryOptions;

    /**
     * Connection lifecycle callbacks. Connection errors are surfaced here —
     * not just logged.
     */
    readonly lifecycle?: AmqpLifecycleCallbacks;

    /**
     * Per-publish broker-outcome deadline in milliseconds. A publish whose
     * ack/nack/return/connection-loss outcome does not arrive in time
     * rejects with `AmqpPublishTimeoutError` (message state UNKNOWN — an
     * at-least-once producer should republish).
     *
     * A value that is not a finite number of at least `1` (`NaN`,
     * `Infinity`, `0`, a negative number) counts as unset and the default
     * applies; a fraction is floored; a value above `2147483647` (the largest
     * delay a timer honors) is capped to it. There is no "no timeout" value.
     *
     * @default 30000
     */
    readonly publishTimeoutMs?: number;
}

/** Topology establishment mode. */
export const AmqpTopologyMode = {
    ASSERT: "assert",
    CHECK: "check",
    SKIP: "skip",
} as const;

export type AmqpTopologyMode = (typeof AmqpTopologyMode)[keyof typeof AmqpTopologyMode];

/** Serialization metadata and optional wire transcoding. */
export interface AmqpSerializationOptions {
    /**
     * AMQP `contentType` message property.
     *
     * @default "application/protobuf"
     */
    readonly contentType?: string;

    /**
     * Transform the outgoing wire body. Receives the payload bytes the
     * EventBus (or the application) produced. Failures reject the publish
     * with `AmqpSerializationError`.
     */
    readonly encode?: (payload: Uint8Array) => Uint8Array;

    /**
     * Transform the incoming wire body before it reaches the event handler.
     * A failure rejects the message without requeue (`basic.nack` with
     * `requeue: false`): the broker drops it, or dead-letters it when the
     * queue has a dead-letter exchange. Nothing is thrown or reported, and the
     * handler never sees the message.
     */
    readonly decode?: (content: Uint8Array) => Uint8Array;
}

/** Declarative topology. */
export interface AmqpTopology {
    readonly exchanges?: readonly AmqpExchangeDeclaration[];
    readonly queues?: readonly AmqpQueueDeclaration[];
    readonly bindings?: readonly AmqpBindingDeclaration[];
}

export interface AmqpExchangeDeclaration {
    readonly name: string;
    readonly type: "topic" | "direct" | "fanout" | "headers";
    readonly durable?: boolean;
    readonly autoDelete?: boolean;
    /** Raw AMQP arguments passthrough. */
    readonly arguments?: Record<string, unknown>;
}

export interface AmqpQueueDeclaration {
    readonly name: string;
    readonly durable?: boolean;
    readonly autoDelete?: boolean;
    readonly exclusive?: boolean;
    /** Raw AMQP arguments passthrough (e.g. x-dead-letter-exchange). */
    readonly arguments?: Record<string, unknown>;
}

export interface AmqpBindingDeclaration {
    /** Destination queue name (queue binding) — mutually exclusive with `exchange`. */
    readonly queue?: string;
    /** Destination exchange name (exchange-to-exchange binding). */
    readonly exchange?: string;
    /** Source exchange. */
    readonly source: string;
    readonly routingKey: string;
    readonly arguments?: Record<string, unknown>;
}

/** External queue override for a consumer group. */
export interface AmqpQueueOverride {
    /** Externally-defined queue name to consume from. */
    readonly queue: string;
    /** Raw AMQP arguments used when asserting the queue (assert mode only). */
    readonly arguments?: Record<string, unknown>;
    /** @default true */
    readonly durable?: boolean;
}

/**
 * Recovery knobs (passed through to amqplib's opt-in recovery).
 *
 * `maxRetries` governs BOTH the initial connect and every subsequent recovery
 * series, with the counter reset on each success — so a finite value chosen only
 * to bound startup also caps steady-state recovery and makes the adapter brittle
 * (N consecutive transient failures in any single series stop it permanently).
 * The reconnect delay is symmetric jitter around a capped exponential base —
 * uniform in `[base × (1 − jitter), base × (1 + jitter)]`, rounded, with
 * `base = min(maxDelay / (1 + jitter), initialDelay × factor^(attempt − 1))`.
 * Capping the base below `maxDelay` means the largest jitter offset lands
 * exactly on `maxDelay`, so a delay never exceeds it: at the defaults a
 * saturated delay lies in `[20000, 30000]` ms. This is amqplib's built-in
 * formula (amqplib ≥ 2.2.0, the minimum this package requires); it applies
 * to every reconnect attempt, including those of the bounded initial connect,
 * and the adapter's own `publishRetry` uses the same one.
 *
 * Full jitter with a hard cap is expressible with these knobs: for an intended
 * schedule `I × factor^(n − 1)` capped at `C`, set `jitter: 1`,
 * `initialDelay: I / 2` and `maxDelay: C`. The delay for attempt `n` is then
 * uniform in `[0, min(I × factor^(n − 1), C)]`.
 *
 * The initial connect CAN be bounded independently since 1.3.0 — see
 * {@link AmqpRecoveryOptions.initialConnectMaxRetries}. A schedule the knobs
 * cannot express is set with {@link AmqpRecoveryOptions.backoff}.
 */
export interface AmqpRecoveryOptions {
    /** @default 100 */
    readonly initialDelay?: number;
    /** Upper bound of every reconnect delay in ms: the base is capped at `maxDelay / (1 + jitter)`, so jitter never pushes a delay above it. @default 30000 */
    readonly maxDelay?: number;
    /** @default 2 */
    readonly factor?: number;
    /** Symmetric jitter factor (0..1): the delay is uniform in `[base × (1 − jitter), base × (1 + jitter)]` around the capped base. @default 0.2 */
    readonly jitter?: number;
    /** Attempts per series (initial connect and each recovery series); resets on success. To bound ONLY startup, use {@link initialConnectMaxRetries}. @default Infinity */
    readonly maxRetries?: number;

    /**
     * Bound the retry budget of the INITIAL connect independently of
     * steady-state recovery: N retries = N+1 attempts, mirroring `maxRetries`
     * semantics. A single `maxRetries` cannot express "bounded startup,
     * unbounded steady-state" — its counter resets on every success.
     *
     * Set to a finite number N, the initial connect makes at most
     * `max(0, floor(N)) + 1` attempts (a negative value means a single
     * attempt, a fraction is rounded down). A value that is not a finite
     * number — `Infinity`, `NaN` — counts as unset. The budget ends with the
     * first successful connect; after that `maxRetries` bounds every recovery
     * series.
     *
     * amqplib runs these attempts itself (its `initialMaxRetries`) on the
     * recovering connection the adapter keeps: each attempt includes the full
     * topology setup, and after a success exactly one adapter connection stays
     * open on the broker. The adapter's lifecycle wiring is attached before
     * the first attempt, so the initial window reports `reconnecting` for
     * every scheduled retry (with the applied delay) and
     * `setup-failed { initial: true, attempt }` for a topology failure
     * (`attempt` is the 0-based index of the failed attempt). On exhaustion
     * the adapter reports one terminal `reconnect-failed`, then `connect()`
     * rejects with `AmqpConnectionError` stating the attempt count and the
     * budget, with the last attempt's error as `cause` — never a silent
     * block. Delays follow the knobs above, like every reconnect delay.
     *
     * `publish()` and `subscribe()` called before the initial connect
     * succeeds reject with `AmqpConnectionError` ("not connected"), and the
     * initial `connected` event is delivered only once the adapter is usable.
     * `disconnect()` during the initial connect cancels a pending retry at
     * once; `connect()` then rejects with `AmqpConnectionError` ("Adapter
     * closed during the initial connect phase") and no lifecycle event
     * follows. `failFastOnInitialSetupError` still stops the initial connect
     * on the first topology error, budget notwithstanding.
     *
     * Unset (default): amqplib's initial loop with the shared `maxRetries`
     * governs startup, and initial-window per-retry events are not surfaced.
     * Since 1.3.0.
     */
    readonly initialConnectMaxRetries?: number;

    /**
     * Custom reconnect delay: called with the attempt number, returns the
     * delay in milliseconds before that attempt. Forwarded to amqplib's
     * `calculateDelay`. Since 1.3.0.
     *
     * - `attempt` is 1-based and restarts at 1 after every successful connect.
     * - Covers every reconnect attempt: steady-state recovery and the retries
     *   of the initial connect (with or without `initialConnectMaxRetries`).
     *   It does NOT cover `publishRetry`, which keeps its own numeric backoff.
     * - The return value must be a finite number ≥ 0. It is rounded to whole
     *   milliseconds and applied as is — NOT clamped to `maxDelay`; cap it
     *   yourself (`Math.min(cap, …)`). `0` is valid and retries at once. The
     *   `reconnecting` event reports this applied delay; the adapter never
     *   calls the hook a second time to fill it.
     * - The hook MUST be synchronous. A throw, a return that is not a finite
     *   number ≥ 0 (`NaN`, `Infinity`, a negative number, a numeric string)
     *   or a Promise (an `async` function) ends recovery for good — there is
     *   no fallback to the built-in schedule. During the initial connect,
     *   `connect()` rejects, and with `initialConnectMaxRetries` the terminal
     *   `reconnect-failed` is reported first; without it the initial loop runs
     *   before the lifecycle wiring attaches, so no event is reported. In
     *   steady state the terminal `reconnect-failed` fires once and the
     *   adapter drops the dead connection, as after an exhausted
     *   `maxRetries`. Either way the error is an
     *   `AmqpConnectionError` whose `cause` is the hook's error (the thrown
     *   error, or one stating the invalid return or that the hook must be
     *   synchronous) and whose message names the last connection error —
     *   "none observed" when it failed before the adapter could see one
     *   (initial connect without `initialConnectMaxRetries`).
     * - It only sets intervals. Retry budgets stay `maxRetries` and
     *   `initialConnectMaxRetries`, and both remain valid with the hook.
     * - Cannot be combined with `initialDelay`, `maxDelay`, `factor` or
     *   `jitter`: amqplib ignores them once a hook is set, so the adapter
     *   rejects the combination at construction with a `TypeError`.
     * - A schedule that depends on the previous delay (decorrelated jitter)
     *   needs state across calls: keep it in a closure.
     *
     * @example Full jitter over an exponential schedule, capped at 30 s
     * ```typescript
     * recovery: {
     *     backoff: (n) => Math.random() * Math.min(30_000, 100 * 2 ** (n - 1)),
     * }
     * ```
     */
    readonly backoff?: (attempt: number) => number;
}

/**
 * Discriminated connection lifecycle event, delivered to
 * {@link AmqpLifecycleCallbacks.onLifecycle}.
 *
 * Exactly-once guarantees (pinned by integration tests):
 * - `connected` fires once per successful (re)connect; `reconnected` is `false`
 *   for the initial connect and `true` after a recovery.
 * - `disconnected` fires once per connection loss (a socket-level cut no longer
 *   double-fires via the raw `error` event — fixed in 1.3.0).
 * - `reconnecting` fires once per scheduled retry — after the connection has
 *   been established once, and also for every retry of the initial connect
 *   when {@link AmqpRecoveryOptions.initialConnectMaxRetries} is set.
 *   `reconnect-failed` is terminal and fires for any of its four triggers:
 *   the retry budget is exhausted (`maxRetries`), the fatal topology policy
 *   stopped the cycle (`treatTopologyErrorAsFatal`), the initial connect
 *   budget ran out (`initialConnectMaxRetries`), or the
 *   {@link AmqpRecoveryOptions.backoff} hook failed in steady-state recovery
 *   or in a bounded initial connect (the event then carries an
 *   `AmqpConnectionError` with the hook's error as `cause`). Without
 *   `initialConnectMaxRetries` a hook failure in the initial loop happens
 *   before the lifecycle wiring attaches: `connect()` rejects and no event
 *   is reported. Once it fires, the adapter
 *   has already dropped the dead connection and its subscriptions:
 *   `publish()` and `subscribe()` reject with `AmqpConnectionError`
 *   ("not connected"), and a new `connect()` starts from a clean state —
 *   re-subscribe explicitly.
 * - `setup-failed` reports a topology/setup failure with `initial: true` for
 *   the startup window (`attempt: 0` on the probe; the 0-based index of the
 *   failed attempt under `initialConnectMaxRetries`) or `initial: false` for
 *   a reconnect re-assert (`attempt` >= 1).
 * - `blocked`/`unblocked` surface broker flow control (RabbitMQ
 *   `connection.blocked`, e.g. under a memory/disk alarm); they have no flat
 *   callback equivalent.
 * - `settlement-skipped` reports an acknowledge, requeue or reject that the
 *   adapter skipped because the consumer channel was already closed. It is a
 *   diagnostic, not a failure: the broker requeues every delivery that was not
 *   acknowledged before the channel closed, so the message is redelivered. On a
 *   quorum queue each such return counts toward the queue's delivery limit
 *   (default 20 since RabbitMQ 4.0); past it the broker drops the message or
 *   dead-letters it. Union-only (no flat callback).
 * - `lifecycle-error` reports a lifecycle callback that threw or returned a
 *   promise that rejected. The failure is already isolated; the event only
 *   makes it visible. A failure while handling a `lifecycle-error` is dropped.
 *   Union-only (no flat callback).
 *
 * Disconnect cause: `disconnected.error` is the error amqplib reports for the
 * close with `recovery` enabled and disabled alike (so a broker-forced close
 * exposes its reply `code`); only a close that carries no cause at all gets a
 * synthetic `Error("Connection closed")`.
 *
 * Scope: with amqplib's own initial loop (default), the retry loop of the
 * INITIAL connect (broker unreachable when `connect()` is called) happens
 * before the lifecycle wiring can attach, so its per-retry events are not
 * surfaced; the startup probe covers the deterministic-misconfiguration case
 * (`setup-failed { initial: true }`). Set
 * {@link AmqpRecoveryOptions.initialConnectMaxRetries} (since 1.3.0) to bound
 * that window: the wiring is then attached before the first attempt, so it
 * reports per-attempt `reconnecting`/`setup-failed` events and a terminal
 * `reconnect-failed` on budget exhaustion.
 *
 * The `type` values are deliberately broker-agnostic so a future
 * cross-adapter generalization stays non-breaking.
 */
export type AmqpLifecycleEvent =
    | { readonly type: "connected"; readonly reconnected: boolean }
    | { readonly type: "disconnected"; readonly error: Error }
    | { readonly type: "reconnecting"; readonly attempt: number; readonly delay: number; readonly error: Error }
    | { readonly type: "reconnect-failed"; readonly error: Error }
    | { readonly type: "setup-failed"; readonly initial: boolean; readonly attempt: number; readonly error: Error }
    | { readonly type: "blocked"; readonly reason: string }
    | { readonly type: "unblocked" }
    | {
          readonly type: "settlement-skipped";
          readonly action: AmqpSettlementAction;
          readonly queue: string;
          readonly routingKey: string;
          readonly deliveryTag: number;
          readonly error: Error;
      }
    | {
          /**
           * The broker ended a subscription's consumer while the connection
           * stayed up: its queue was deleted or the consumer was cancelled
           * (`cancelled`), or the broker closed the consumer channel with a
           * channel exception (`channel-closed`, with that exception as `error`).
           *
           * Delivered once per loss. Not delivered for a connection loss (the
           * connection's own `disconnected` covers it and connection recovery
           * restores the subscription), nor for `unsubscribe()` / `disconnect()`.
           */
          readonly type: "consumer-lost";
          readonly queue: string;
          readonly cause: AmqpConsumerLossCause;
          readonly error?: Error;
          /** `true` when `recovery` is enabled and the adapter will try to restore the consumer. */
          readonly willRestore: boolean;
      }
    | {
          /**
           * A lost consumer is consuming again. For a subscription without a
           * group `queue` is the NEW auto-named queue.
           */
          readonly type: "consumer-restored";
          readonly queue: string;
          /** 1-based number of the restoration attempt that succeeded. */
          readonly attempt: number;
      }
    | {
          /**
           * A restoration attempt failed. `willRetry: false` means this
           * subscription's restoration has ended (a failure that cannot heal
           * without a configuration or topology change); other subscriptions
           * and the connection are unaffected.
           */
          readonly type: "consumer-restore-failed";
          readonly queue: string;
          /** 1-based number of the failed attempt. */
          readonly attempt: number;
          readonly error: Error;
          readonly willRetry: boolean;
      }
    | {
          readonly type: "lifecycle-error";
          /** Name of the callback that failed: `onLifecycle` or a flat callback such as `onReconnecting`. */
          readonly callback: string;
          /** `type` of the event that callback was handling. */
          readonly event: string;
          readonly error: Error;
      };

/** How the broker ended a consumer: cancelled it (e.g. queue deleted) or closed its channel with an exception. */
export type AmqpConsumerLossCause = "cancelled" | "channel-closed";

/** What the adapter intended to do with a delivery when its settlement was skipped. */
export type AmqpSettlementAction = "ack" | "requeue" | "reject";

/**
 * Tuning for the opt-in bounded publish retry
 * ({@link AmqpAdapterOptions.publishRetry}). Backoff knobs mirror
 * {@link AmqpRecoveryOptions} (same names, same formula — a delay never
 * exceeds `maxDelay`) — but `maxRetries` defaults to a BOUNDED `5` here, not
 * `Infinity`.
 */
export interface AmqpPublishRetryOptions {
    /** Retries after the first attempt (N retries = N+1 attempts). A negative value, including `-Infinity`, clamps to `0` (single attempt); `Infinity` is honored — retry until `disconnect()` aborts; `NaN` counts as unset. A fraction is floored. @default 5 */
    readonly maxRetries?: number;
    /** First retry delay in ms. @default 100 */
    readonly initialDelay?: number;
    /** Upper bound of every retry delay in ms; jitter never pushes a delay above it. @default 30000 */
    readonly maxDelay?: number;
    /** Exponential backoff factor. @default 2 */
    readonly factor?: number;
    /** Symmetric jitter factor (0..1). @default 0.2 */
    readonly jitter?: number;
    /**
     * Also retry `AmqpPublishTimeoutError` (no broker outcome within
     * `publishTimeoutMs`). The message state at a timeout is UNKNOWN, so this
     * raises the duplicate likelihood — enable only with consumer-side dedup.
     * @default false
     */
    readonly retryOnTimeout?: boolean;
    /**
     * Observability hook, invoked once per scheduled retry. MUST NOT throw
     * (exceptions are isolated). Scoped here deliberately — publish retries
     * are per-operation events, not connection lifecycle, so they do not join
     * {@link AmqpLifecycleEvent}.
     */
    readonly onRetry?: (info: { readonly attempt: number; readonly delay: number; readonly error: Error; readonly routingKey: string }) => void;
}

/**
 * Connection lifecycle callbacks.
 *
 * Prefer the single discriminated {@link onLifecycle} callback; the flat
 * callbacks are a compatibility shim over the same event stream and are
 * deprecated since 1.3.0 (removal not before 2.0).
 */
export interface AmqpLifecycleCallbacks {
    /**
     * Single discriminated-union lifecycle callback — the preferred surface.
     * Receives every {@link AmqpLifecycleEvent}, including `blocked`/`unblocked`,
     * which have no flat-callback equivalent. Flat callbacks (if also set) are
     * invoked after `onLifecycle` for the same underlying event.
     *
     * Should not throw: dispatch runs inside the connection driver's event
     * handlers, so a thrown exception or a rejected returned promise is
     * isolated to protect the connection — it neither disturbs recovery nor
     * starves the flat shim, and it is reported as a `lifecycle-error` event.
     * The adapter does NOT await a returned promise: events are dispatched in
     * order, but a slow async callback may finish after later events.
     *
     * Setting this (like `onSetupFailed` / `failFastOnInitialSetupError`)
     * enables the startup validation probe: one extra short-lived connection
     * plus a topology validation pass at `connect()` (requires recovery
     * enabled), so `setup-failed { initial: true }` can be delivered for a
     * deterministic misconfiguration at boot. With
     * {@link AmqpRecoveryOptions.initialConnectMaxRetries} no probe runs: the
     * initial attempts themselves report their setup failures.
     */
    readonly onLifecycle?: (event: AmqpLifecycleEvent) => void;
    /** @deprecated Since 1.3.0 — use {@link onLifecycle} (`type: "connected"`). Kept until at least 2.0. */
    readonly onConnected?: () => void;
    /** @deprecated Since 1.3.0 — use {@link onLifecycle} (`type: "disconnected"`). Kept until at least 2.0. */
    readonly onDisconnected?: (cause: Error) => void;
    /**
     * A reconnect attempt has been scheduled. Fires exactly ONCE per scheduled
     * retry (amqplib's `reconnect-scheduled`). A failed attempt that also emits
     * `connect-failed` does NOT double-invoke this; the terminal case (retry
     * budget exhausted, or a fatal topology stop under
     * `treatTopologyErrorAsFatal`) is reported via {@link onReconnectFailed},
     * not here.
     *
     * @deprecated Since 1.3.0 — use {@link onLifecycle} (`type: "reconnecting"`). Kept until at least 2.0.
     */
    readonly onReconnecting?: (info: { attempt: number; delay: number; error: Error }) => void;
    /** @deprecated Since 1.3.0 — use {@link onLifecycle} (`type: "reconnect-failed"`). Kept until at least 2.0. */
    readonly onReconnectFailed?: (cause: Error) => void;
    /**
     * A setup/topology failure occurred while (re)applying the declarative
     * topology — during the startup window (`ctx.initial: true`; `ctx.attempt`
     * is 0 on the probe, or the 0-based index of the failed attempt under
     * `initialConnectMaxRetries`) and/or on a reconnect whose topology
     * re-assert fails (`ctx.initial: false`, `ctx.attempt` ≥ 1).
     *
     * This surfaces deterministic configuration drift (e.g. a missing queue in
     * `check` mode, or a `PRECONDITION_FAILED` redeclare) distinctly from a mere
     * broker outage, even when fail-fast is off. Without
     * `initialConnectMaxRetries`, the initial-connect invocation requires a
     * startup validation probe, which runs when either this callback,
     * {@link onLifecycle}, or {@link AmqpAdapterOptions.failFastOnInitialSetupError} is set.
     *
     * @deprecated Since 1.3.0 — use {@link onLifecycle} (`type: "setup-failed"`). Kept until at least 2.0.
     */
    readonly onSetupFailed?: (error: Error, ctx: { readonly initial: boolean; readonly attempt: number }) => void;
}

/**
 * Exchange assertion options.
 */
export interface AmqpExchangeOptions {
    /**
     * Whether the exchange should survive broker restarts.
     *
     * @default true
     */
    readonly durable?: boolean;

    /**
     * Whether the exchange is deleted when the last queue unbinds.
     *
     * @default false
     */
    readonly autoDelete?: boolean;
}

/**
 * Queue assertion options.
 */
export interface AmqpQueueOptions {
    /**
     * Whether the queue should survive broker restarts.
     *
     * @default true
     */
    readonly durable?: boolean;

    /**
     * Per-message TTL in milliseconds.
     */
    readonly messageTtl?: number;

    /**
     * Maximum number of messages in the queue.
     */
    readonly maxLength?: number;

    /**
     * Dead letter exchange name for rejected messages.
     */
    readonly deadLetterExchange?: string;

    /**
     * Dead letter routing key for rejected messages.
     */
    readonly deadLetterRoutingKey?: string;
}

/**
 * Consumer options.
 */
export interface AmqpConsumerOptions {
    /**
     * Prefetch count (QoS) — how many unacknowledged messages
     * a consumer can have at a time.
     *
     * @default 10
     */
    readonly prefetch?: number;

    /**
     * Whether the private queue of a subscription without `group` is exclusive
     * to the subscriber's connection, so the broker removes it with that
     * connection. RabbitMQ 4.3 and later refuse a queue that is neither
     * durable nor exclusive, so `false` works only on older brokers or where the
     * `transient_nonexcl_queues` deprecated feature is permitted. Subscriptions
     * with `group` use a durable shared queue and ignore this option.
     *
     * @default true
     */
    readonly exclusive?: boolean;
}

/**
 * Publisher options.
 */
export interface AmqpPublisherOptions {
    /**
     * Whether messages should be persisted to disk (deliveryMode=2).
     *
     * @default true
     */
    readonly persistent?: boolean;

    /**
     * Whether the message should be returned if it cannot be routed.
     * Unroutable messages reject the publish with `AmqpUnroutableError`.
     *
     * @default false
     */
    readonly mandatory?: boolean;

    /**
     * How `basic.return` frames are correlated to publishes when
     * `mandatory: true`. The return frame carries no deliveryTag, so:
     *
     * - `true` (default): stamp a private `x-connectum-publish-id` header on
     *   mandatory publishes and match returns by it. The header is visible
     *   on the wire to external consumers — document it in contracts.
     * - `false`: no header; mandatory publishes are serialized
     *   (single-flight) so at most one is outstanding at a time —
     *   correlation is unambiguous at the cost of throughput.
     *
     * @default true
     */
    readonly correlationHeader?: boolean;

    /**
     * Publish against an EXTERNAL (non-EventBus) message contract: suppress the
     * EventBus envelope so the wire frame carries ONLY contract-specified
     * properties. For an external AsyncAPI/AMQP contract the oracle is the
     * published spec, not this serializer — a third-party consumer validates the
     * exact header/property set, which must not include adapter-internal fields.
     *
     * When `true`, `publish()`:
     * - does NOT stamp the `x-event-id` / `x-published-at` headers;
     * - does NOT auto-populate the `messageId` or `timestamp` properties;
     * - uses single-flight correlation for `mandatory` publishes (so no
     *   `x-connectum-publish-id` header reaches the wire) — `correlationHeader`
     *   is ignored in this mode.
     *
     * The frame then carries only `contentType`, `persistent`/deliveryMode,
     * `mandatory`, and exactly the headers passed via `PublishOptions.metadata`.
     * Per-message confirms, `mandatory` → `AmqpUnroutableError`, the typed error
     * taxonomy, and connection recovery are unchanged.
     *
     * Leave unset (default) for normal EventBus use, where the envelope is
     * stamped on publish and stripped on delivery. When the contract requires a
     * specific `messageId` / `timestamp`, set them per-publish via
     * `PublishOptions.messageId` / `PublishOptions.timestamp` (a caller-supplied
     * value is used as-is; in external-contract mode nothing is auto-generated).
     *
     * @default false
     */
    readonly externalContract?: boolean;
}

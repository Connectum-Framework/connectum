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
     * Exchange type.
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
     * `maxRetries` governs BOTH the initial connect and steady-state recovery
     * (counter reset on success); under the default `Infinity`, `connect()`
     * blocks until the broker is reachable rather than failing fast (see
     * {@link AmqpAdapterOptions.failFastOnInitialSetupError} to fail fast on a
     * deterministic startup misconfiguration). See {@link AmqpRecoveryOptions}
     * for the retry-budget scope and jitter/`maxDelay` overshoot.
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
     * await — no callback. When this flag is `true` (and recovery is enabled), the
     * adapter first validates topology against a throwaway non-recovering
     * connection; a topology error rejects `connect()` with the typed
     * `AmqpTopologyError` / `AmqpConnectionError`.
     *
     * Only deterministic setup/topology errors fail fast. A transient
     * broker-unreachable at startup is NOT a fail-fast condition — it falls
     * through to normal recovery (block-until-broker). SUBSEQUENT reconnects
     * always keep infinite-recovery behavior.
     *
     * No-op with `recovery: false` (that path already fails fast on setup).
     * Enabling this — or supplying {@link AmqpLifecycleCallbacks.onLifecycle}
     * or {@link AmqpLifecycleCallbacks.onSetupFailed} — adds one extra
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
     * The gate is the AMQP reply code of the failure cause — `404`
     * (NOT_FOUND) or `406` (PRECONDITION_FAILED) — NOT the error class:
     * transient causes wrapped into `AmqpTopologyError` during a setup pass
     * (broker restarting `320`, internal error `541`, resource locked `405`,
     * a mid-setup connection drop) stay in normal recovery. One known
     * transient 404 is excluded explicitly: a RabbitMQ cluster classic queue
     * whose home node is down ("... down or inaccessible") stays in recovery.
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
     * whose bounded phase surfaces those failures and rejects on exhaustion.
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
     * - **Deterministic channel-close is not retried**: a broker reply with a
     *   `404`/`406` code that killed the publish CHANNEL (e.g. a publish to a
     *   missing exchange under `topologyMode: "skip"`) surfaces immediately
     *   with the broker reply as `cause` — the connection stays up, recovery
     *   never recreates the channel, so retrying cannot heal.
     *
     * Backoff mirrors the recovery formula (same knob names and semantics,
     * incl. cap-before-jitter), but the DEFAULT budget differs: `maxRetries`
     * here defaults to **5** (bounded), not `Infinity`.
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
     * Failures nack the message (requeue per consumer policy).
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
 * The effective reconnect delay is symmetric jitter around the exponential
 * base — uniform in `[base × (1 − jitter), base × (1 + jitter)]` with
 * `base = min(maxDelay, initialDelay × factor^(attempt − 1))`. The cap applies
 * BEFORE jitter, so the wait can overshoot `maxDelay` (~20% at the default
 * jitter, up to ~2x at `jitter: 1`).
 *
 * Full jitter with a hard cap is expressible today: set `jitter: 1` and halve
 * `initialDelay`/`maxDelay` — the delay becomes uniform in `[0, intended cap]`
 * (verified against amqplib 2.0.1's internal formula; re-verify on upgrades).
 *
 * The initial connect CAN be bounded independently since 1.3.0 — see
 * {@link AmqpRecoveryOptions.initialConnectMaxRetries} (#198; upstream native
 * support tracked in {@link https://github.com/amqp-node/amqplib/issues/856}).
 * A pluggable backoff hook remains tracked in
 * {@link https://github.com/Connectum-Framework/connectum/issues/199}
 * (upstream: {@link https://github.com/amqp-node/amqplib/issues/855}).
 */
export interface AmqpRecoveryOptions {
    /** @default 100 */
    readonly initialDelay?: number;
    /** Base delay cap in ms; jitter is applied on top of the capped base, so the effective wait can exceed it. @default 30000 */
    readonly maxDelay?: number;
    /** @default 2 */
    readonly factor?: number;
    /** Symmetric jitter factor (0..1): the delay is uniform in `[base × (1 − jitter), base × (1 + jitter)]`. @default 0.2 */
    readonly jitter?: number;
    /** Attempts per series (initial connect and each recovery series); resets on success. To bound ONLY startup, use {@link initialConnectMaxRetries}. @default Infinity */
    readonly maxRetries?: number;

    /**
     * Bound the retry budget of the INITIAL connect independently of
     * steady-state recovery: N retries = N+1 attempts, mirroring `maxRetries`
     * semantics. A single `maxRetries` cannot express "bounded startup,
     * unbounded steady-state" — its counter resets on every success.
     *
     * When set to an explicit finite value (a negative value clamps to `0` —
     * single attempt — mirroring amqplib's `maxRetries` normalization), the
     * adapter owns the initial window with a bounded validate-connect loop
     * (the startup probe folds into it — validation IS each attempt, no extra
     * connects): every
     * attempt surfaces per-attempt lifecycle events (`reconnecting` with the
     * next delay, `setup-failed { initial: true, attempt }` for topology
     * failures), and budget exhaustion rejects `connect()` with a typed
     * `AmqpConnectionError` after a terminal `reconnect-failed` — never a
     * silent block. Backoff matches amqplib's steady-state formula exactly
     * (same knobs above, same cap-before-jitter semantics).
     *
     * `failFastOnInitialSetupError` still short-circuits a deterministic
     * topology error on the first sight, budget notwithstanding.
     *
     * Handoff caveat: after a successful validation the real recovering
     * connect runs — a broker dying inside that small window blocks per
     * amqplib's own initial loop.
     *
     * Unset (default): behavior unchanged — amqplib's initial loop with the
     * shared `maxRetries` governs startup, and initial-window per-retry events
     * are not surfaced. Since 1.3.0; upstream native support tracked in
     * {@link https://github.com/amqp-node/amqplib/issues/856}.
     */
    readonly initialConnectMaxRetries?: number;
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
 *   been established once, and also per attempt of the bounded initial phase
 *   when {@link AmqpRecoveryOptions.initialConnectMaxRetries} is set.
 *   `reconnect-failed` is terminal and fires for any of its three triggers:
 *   the retry budget is exhausted (`maxRetries`), the fatal topology policy
 *   stopped the cycle (`treatTopologyErrorAsFatal`), or the initial connect
 *   budget ran out (`initialConnectMaxRetries`).
 * - `setup-failed` reports a topology/setup failure with `initial: true` for
 *   the startup window (`attempt: 0` on the probe; the 0-based attempt index
 *   in the bounded initial phase) or `initial: false` for a reconnect
 *   re-assert (`attempt` >= 1).
 * - `blocked`/`unblocked` surface broker flow control (RabbitMQ
 *   `connection.blocked`, e.g. under a memory/disk alarm); they have no flat
 *   callback equivalent.
 *
 * Scope: with amqplib's own initial loop (default), the retry loop of the
 * INITIAL connect (broker unreachable when `connect()` is called) happens
 * before the lifecycle wiring can attach, so its per-retry events are not
 * surfaced; the startup probe covers the deterministic-misconfiguration case
 * (`setup-failed { initial: true }`). Set
 * {@link AmqpRecoveryOptions.initialConnectMaxRetries} (since 1.3.0) to make
 * the adapter own that window — its bounded phase surfaces per-attempt
 * `reconnecting`/`setup-failed` events and a terminal `reconnect-failed` on
 * budget exhaustion.
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
    | { readonly type: "unblocked" };

/**
 * Tuning for the opt-in bounded publish retry
 * ({@link AmqpAdapterOptions.publishRetry}). Backoff knobs mirror
 * {@link AmqpRecoveryOptions} (same names, same cap-before-jitter semantics)
 * — but `maxRetries` defaults to a BOUNDED `5` here, not `Infinity`.
 */
export interface AmqpPublishRetryOptions {
    /** Retries after the first attempt (N retries = N+1 attempts). `Infinity` is honored — retry until `disconnect()` aborts. @default 5 */
    readonly maxRetries?: number;
    /** First retry delay in ms. @default 100 */
    readonly initialDelay?: number;
    /** Base delay cap in ms; jitter applies on top of the capped base. @default 30000 */
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
     * MUST NOT throw: dispatch runs inside the connection driver's event
     * handlers, so exceptions are isolated (swallowed) to protect the
     * connection — a throwing callback neither disturbs recovery nor starves
     * the flat shim.
     *
     * Setting this (like `onSetupFailed` / `failFastOnInitialSetupError`)
     * enables the startup validation probe: one extra short-lived connection
     * plus a topology validation pass at `connect()` (requires recovery
     * enabled), so `setup-failed { initial: true }` can be delivered for a
     * deterministic misconfiguration at boot.
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
     * is 0 on the probe, or the 0-based attempt index in the bounded initial
     * phase) and/or on a reconnect whose topology re-assert fails
     * (`ctx.initial: false`, `ctx.attempt` ≥ 1).
     *
     * This surfaces deterministic configuration drift (e.g. a missing queue in
     * `check` mode, or a `PRECONDITION_FAILED` redeclare) distinctly from a mere
     * broker outage, even when fail-fast is off. The initial-connect invocation
     * requires a startup validation probe, which runs when either this callback,
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
     * Whether the consumer is exclusive to this connection.
     *
     * @default false
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

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
     * Enabling this (or supplying {@link AmqpLifecycleCallbacks.onSetupFailed})
     * adds one extra short-lived connection at startup for the validation probe.
     *
     * @default false
     */
    readonly failFastOnInitialSetupError?: boolean;

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
 * The effective reconnect delay is amqplib equal-jitter around the exponential
 * base and is NOT clamped to `maxDelay` from above, so it can overshoot (~20% at
 * the default jitter, up to ~2x at `jitter: 1`).
 *
 * Bounding the initial connect independently from steady-state recovery, and a
 * backoff hook that owns (and can clamp) the final delay, are tracked as future
 * options — see
 * {@link https://github.com/Connectum-Framework/connectum/issues/198} and
 * {@link https://github.com/Connectum-Framework/connectum/issues/199}.
 */
export interface AmqpRecoveryOptions {
    /** @default 100 */
    readonly initialDelay?: number;
    /** Base delay cap in ms; jitter is added on top, so the effective wait can exceed it. @default 30000 */
    readonly maxDelay?: number;
    /** @default 2 */
    readonly factor?: number;
    /** Equal-jitter factor (0..1) around the base delay. @default 0.2 */
    readonly jitter?: number;
    /** Attempts per series (initial connect and each recovery series); resets on success. @default Infinity */
    readonly maxRetries?: number;
}

/** Connection lifecycle callbacks. */
export interface AmqpLifecycleCallbacks {
    readonly onConnected?: () => void;
    readonly onDisconnected?: (cause: Error) => void;
    /**
     * A reconnect attempt has been scheduled. Fires exactly ONCE per scheduled
     * retry (amqplib's `reconnect-scheduled`). A failed attempt that also emits
     * `connect-failed` does NOT double-invoke this; the terminal, retries-exhausted
     * case is reported via {@link onReconnectFailed}, not here.
     */
    readonly onReconnecting?: (info: { attempt: number; delay: number; error: Error }) => void;
    readonly onReconnectFailed?: (cause: Error) => void;
    /**
     * A setup/topology failure occurred while (re)applying the declarative
     * topology — on the initial connect's validation probe (`ctx.initial: true`,
     * `ctx.attempt: 0`) and/or on a reconnect whose topology re-assert fails
     * (`ctx.initial: false`, `ctx.attempt` ≥ 1).
     *
     * This surfaces deterministic configuration drift (e.g. a missing queue in
     * `check` mode, or a `PRECONDITION_FAILED` redeclare) distinctly from a mere
     * broker outage, even when fail-fast is off. The initial-connect invocation
     * requires a startup validation probe, which runs when either this callback or
     * {@link AmqpAdapterOptions.failFastOnInitialSetupError} is set.
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

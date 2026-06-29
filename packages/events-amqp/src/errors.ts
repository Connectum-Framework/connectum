/**
 * Typed error taxonomy for the AMQP adapter.
 *
 * Every terminal publish/topology outcome is distinguishable by error class,
 * which is what an at-least-once producer needs for an
 * "advance cursor after confirm" pattern: a non-advanced message corresponds
 * to exactly one typed error explaining why.
 *
 * Authoritative republish policy (do not infer it from class names):
 *
 * | Error                     | Message state      | Republish (at-least-once) |
 * | ------------------------- | ------------------ | ------------------------- |
 * | `AmqpConnectionError`     | not sent / UNKNOWN | Yes                       |
 * | `AmqpPublishTimeoutError` | UNKNOWN            | Yes                       |
 * | `AmqpPublishNackError`    | sent, refused      | Yes (policy: retriable)   |
 * | `AmqpUnroutableError`     | sent, dropped      | No (deterministic)        |
 * | `AmqpSerializationError`  | never sent         | No (deterministic)        |
 * | `AmqpTopologyError`       | N/A                | No (fix config)           |
 *
 * `AmqpConnectionError` is thrown pre-send (never sent) or on an in-flight
 * confirm loss (UNKNOWN); both are republish-safe. The `AmqpSerializationError`
 * row is the publish-side encode failure; the same class is also thrown on the
 * consumer side for a decode failure (nack without requeue), which is outside
 * republish semantics.
 *
 * @module errors
 */

/** Base class for all AMQP adapter errors. */
export class AmqpAdapterError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = new.target.name;
    }
}

/**
 * Connection is absent, lost, or recovery is in progress / exhausted.
 * Publishes during a disconnected window fail fast with this error;
 * in-flight confirms are rejected with it on connection loss.
 */
export class AmqpConnectionError extends AmqpAdapterError {}

/**
 * The broker returned a `mandatory` message as unroutable
 * (`basic.return`): no queue is bound for the routing key.
 */
export class AmqpUnroutableError extends AmqpAdapterError {
    readonly routingKey: string;

    constructor(message: string, routingKey: string) {
        super(message);
        this.routingKey = routingKey;
    }
}

/** The broker negatively acknowledged (nacked) a published message. */
export class AmqpPublishNackError extends AmqpAdapterError {}

/**
 * No broker outcome (ack/nack/return/connection loss) arrived within
 * `publishTimeoutMs`. The message state is UNKNOWN — it may or may not
 * have been routed; an at-least-once producer should republish.
 */
export class AmqpPublishTimeoutError extends AmqpAdapterError {}

/**
 * Topology declaration or verification failed: missing exchange/queue in
 * `check`/`skip` mode, or a conflicting redeclare (PRECONDITION_FAILED) in
 * `assert` mode.
 */
export class AmqpTopologyError extends AmqpAdapterError {}

/** Payload encoding/decoding failed in a custom serialization hook. */
export class AmqpSerializationError extends AmqpAdapterError {}

/**
 * Typed error taxonomy for the AMQP adapter.
 *
 * Every terminal publish/topology outcome is distinguishable by error class,
 * which is what an at-least-once producer needs for an
 * "advance cursor after confirm" pattern: a non-advanced message corresponds
 * to exactly one typed error explaining why.
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

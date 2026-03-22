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
     *
     * @default false
     */
    readonly mandatory?: boolean;
}

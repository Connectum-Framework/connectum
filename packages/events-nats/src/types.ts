/**
 * Configuration types for the NATS JetStream adapter.
 *
 * @module types
 */

import type { NodeConnectionOptions } from "@nats-io/transport-node";

/**
 * Options for creating a NATS JetStream adapter.
 */
export interface NatsAdapterOptions {
    /**
     * NATS server URL(s). Accepts a single string or an array.
     *
     * A non-empty string, or a non-empty array of non-empty strings; anything else makes `NatsAdapter()` throw
     * (an empty value used to make the client dial its local default address).
     */
    readonly servers: string | string[];

    /**
     * JetStream stream name.
     *
     * When set, subjects are prefixed with `{stream}.` and the stream
     * is auto-created on `connect()` if it does not exist.
     *
     * @default "events"
     */
    readonly stream?: string;

    /**
     * NATS connection options (escape hatch for advanced config).
     *
     * The `servers` field from this object is overridden by the
     * top-level `servers` option.
     */
    readonly connectionOptions?: Partial<NodeConnectionOptions>;

    /**
     * Connection lifecycle callback. Without it the adapter attaches no listener to the client and behaves as before.
     */
    readonly lifecycle?: NatsLifecycleCallbacks;

    /** JetStream consumer tuning options. */
    readonly consumerOptions?: NatsConsumerOptions;
}

/**
 * Options for JetStream consumer behaviour.
 */
export interface NatsConsumerOptions {
    /**
     * Deliver policy for new consumers.
     * - `"new"` — only messages published after consumer creation
     * - `"all"` — all available messages
     * - `"last"` — last message per subject
     *
     * Any other value makes `NatsAdapter()` throw (it used to behave like `"new"`).
     *
     * @default "new"
     */
    readonly deliverPolicy?: "new" | "all" | "last";

    /**
     * Ack wait timeout in milliseconds.
     * After this period an unacknowledged message is redelivered.
     *
     * A finite number greater than 0 (a fraction is sent as whole nanoseconds); `0`, a negative
     * number or `NaN` makes `NatsAdapter()` throw (`0` used to become the default, a negative
     * number made the server redeliver at once).
     *
     * @default 30_000
     */
    readonly ackWait?: number;

    /**
     * Maximum number of delivery attempts. When the limit is reached,
     * JetStream stops redelivering the message and emits a max-deliver
     * advisory; the message remains in the stream subject to its retention
     * policy.
     *
     * `-1` means unlimited; otherwise a positive integer. `0`, other negative numbers and fractions
     * make `NatsAdapter()` throw.
     *
     * @default 5
     */
    readonly maxDeliver?: number;

    /**
     * How many messages the server may hand to one consumer ahead of its handler (the size of the
     * client's pull buffer).
     *
     * The server starts the `ackWait` timer of a message when it delivers the message to the client's
     * buffer, not when the handler starts, and the handler of a consumer runs one message at a time.
     * With the client's default buffer of 100, a message at the back of a full buffer is redelivered
     * when `handler time x position` outgrows `ackWait`: with the default `ackWait` of 30 s that
     * starts at about 0.3 s per message, and a single consumer then receives duplicates. A smaller
     * buffer keeps the wait in the buffer short, and the client asks the server for messages more
     * often; `1` keeps at most one message ahead of the handler.
     *
     * An integer from 1 to 2147483647. Unset keeps the client's own default (100), so existing
     * deployments are unchanged.
     */
    readonly prefetch?: number;
}

/**
 * Connection lifecycle events of the NATS adapter, delivered to {@link NatsLifecycleCallbacks.onLifecycle}.
 *
 * A discriminated union on `type`. The strings and the shared fields match the AMQP adapter's events; the
 * type is local to this package. Without the callback the adapter attaches no listener to the client.
 */
export type NatsLifecycleEvent =
    | {
          /** Delivered once after the first connect (`reconnected: false`) and once per recovery (`reconnected: true`). */
          readonly type: "connected";
          readonly reconnected: boolean;
          /** The server reached again; set only for a recovery. */
          readonly server?: string;
      }
    | {
          /** The connection to the server was lost; the client tries to reconnect on its own. Not delivered for `disconnect()`. */
          readonly type: "disconnected";
          readonly server: string;
      }
    | {
          /**
           * The client dials a server again. `attempt` counts dials since the loss (the client reports one per
           * address it tries, not one per round); the client reports no delay or error, so none is given.
           */
          readonly type: "reconnecting";
          readonly attempt: number;
      }
    | {
          /** Terminal: the client closed itself without a `disconnect()` call, typically after its reconnect budget ran out. The adapter drops the dead connection, so `connect()` can start a new one. */
          readonly type: "reconnect-failed";
          readonly error: Error;
      }
    | {
          /** A lifecycle callback threw or returned a rejected promise. */
          readonly type: "lifecycle-error";
          readonly callback: string;
          readonly event: string;
          readonly error: Error;
      };

/** Callbacks for the connection lifecycle of the NATS adapter. */
export interface NatsLifecycleCallbacks {
    /**
     * Called for every {@link NatsLifecycleEvent}. It should not throw: a thrown exception or a rejected
     * returned promise is isolated and reported as a `lifecycle-error` event, and a failure while handling
     * that one is dropped. A returned promise is not awaited.
     *
     * Events of the initial dial that happen before `connect()` returns are not available from the client.
     */
    readonly onLifecycle?: (event: NatsLifecycleEvent) => void | Promise<void>;
}

/**
 * AMQP/RabbitMQ adapter for `@connectum/events`.
 *
 * Implements the {@link EventAdapter} interface on top of AMQP 0-9-1 (RabbitMQ),
 * providing at-least-once delivery with topic exchanges, consumer groups via
 * named queues, dead-letter exchange support, explicit external topology,
 * automatic connection recovery (amqplib opt-in recovery), and per-message
 * publisher confirms with `mandatory`/`basic.return` correlation.
 *
 * @module AmqpAdapter
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import type amqp from "amqplib";
import { AmqpConnectionError, AmqpPublishNackError, AmqpPublishTimeoutError, AmqpSerializationError, AmqpTopologyError, AmqpUnroutableError } from "./errors.ts";
import type { AmqpAdapterOptions, AmqpQueueOverride } from "./types.ts";
import { AmqpTopologyMode } from "./types.ts";

/** Default exchange name when none is provided. */
const DEFAULT_EXCHANGE = "connectum.events";

/** Default exchange type. */
const DEFAULT_EXCHANGE_TYPE = "topic";

/** Default prefetch count. */
const DEFAULT_PREFETCH = 10;

/** Default contentType message property. */
const DEFAULT_CONTENT_TYPE = "application/protobuf";

/** Default broker-outcome deadline for a single publish (ms). */
const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * Private header used to correlate `basic.return` frames to publishes when
 * `mandatory: true` (the return frame carries no deliveryTag). Visible on
 * the wire — documented for external contracts; disable via
 * `publisherOptions.correlationHeader: false` (switches to single-flight).
 */
const PUBLISH_ID_HEADER = "x-connectum-publish-id";

/**
 * Convert an EventBus wildcard pattern to an AMQP routing key pattern.
 *
 * EventBus uses NATS-style wildcards:
 * - `*` matches a single token (same in AMQP topic exchange)
 * - `>` matches one or more tokens (AMQP uses `#`)
 *
 * @param pattern - EventBus wildcard pattern
 * @returns AMQP routing key pattern
 */
export function toAmqpPattern(pattern: string): string {
    return pattern.replace(/>/g, "#");
}

/**
 * Parse AMQP message headers into a `Map<string, string>`.
 *
 * Only string-coercible values are included. All headers are passed
 * through; internal EventBus headers (`x-event-id`, `x-published-at`)
 * are removed by the consumer callback after extraction.
 */
function parseHeaders(headers: Record<string, unknown> | undefined): Map<string, string> {
    const map = new Map<string, string>();
    if (!headers) {
        return map;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && value !== null) {
            map.set(key, String(value));
        }
    }
    return map;
}

/** Internal record of an active subscription, replayable after recovery. */
interface SubscriptionRecord {
    readonly patterns: string[];
    readonly handler: RawEventHandler;
    readonly subOptions: RawSubscribeOptions | undefined;
    /** Channel of the CURRENT incarnation (replaced on recovery). */
    channel: amqp.Channel | null;
    consumerTag: string | null;
    queueName: string;
    isAutoGroup: boolean;
    active: boolean;
}

/** Pending mandatory publish awaiting its confirm, keyed by publish id. */
interface PendingReturn {
    returned: boolean;
}

/**
 * Create an AMQP/RabbitMQ adapter for @connectum/events.
 *
 * @param options - AMQP adapter configuration
 * @returns EventAdapter instance
 *
 * @example
 * ```typescript
 * import { AmqpAdapter } from "@connectum/events-amqp";
 * import { createEventBus } from "@connectum/events";
 *
 * const bus = createEventBus({
 *     adapter: AmqpAdapter({ url: "amqp://guest:guest@localhost:5672" }),
 *     routes: [myRoutes],
 * });
 * await bus.start();
 * ```
 *
 * @example External AMQP contract (AsyncAPI-style)
 * ```typescript
 * const adapter = AmqpAdapter({
 *     url: "amqp://broker:5672",
 *     exchange: "partner.direct",
 *     exchangeType: "direct",
 *     serialization: { contentType: "application/json" },
 *     topology: {
 *         queues: [{
 *             name: "partner.inbound.v1",
 *             durable: true,
 *             arguments: {
 *                 "x-dead-letter-exchange": "partner.dlx",
 *                 "x-dead-letter-routing-key": "inbound.dead",
 *             },
 *         }],
 *         bindings: [{ queue: "partner.inbound.v1", source: "partner.direct", routingKey: "inbound" }],
 *     },
 *     queueOverrides: { partner: { queue: "partner.inbound.v1" } },
 *     publisherOptions: { persistent: true, mandatory: true },
 * });
 * ```
 */
export function AmqpAdapter(options: AmqpAdapterOptions): EventAdapter {
    const exchange = options.exchange ?? DEFAULT_EXCHANGE;
    const exchangeType = options.exchangeType ?? DEFAULT_EXCHANGE_TYPE;
    const topologyMode = options.topologyMode ?? AmqpTopologyMode.ASSERT;
    const contentType = options.serialization?.contentType ?? DEFAULT_CONTENT_TYPE;
    const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    const correlationHeader = options.publisherOptions?.correlationHeader ?? true;
    const lifecycle = options.lifecycle;

    /** The recovering connection wrapper (amqplib opt-in recovery) or a plain connection. */
    let connection: amqp.ChannelModel | null = null;
    let publishChannel: amqp.ConfirmChannel | null = null;
    let closing = false;

    /** Pending mandatory publishes awaiting confirm (publish-id → return flag). */
    const pendingReturns = new Map<string, PendingReturn>();

    /** Single-flight chain for mandatory publishes when the header is disabled. */
    let mandatoryChain: Promise<unknown> = Promise.resolve();

    /** Replayable registry of subscriptions (source of truth across recoveries). */
    const subscriptionRecords: SubscriptionRecord[] = [];

    /** Wrap a broker/channel error into AmqpTopologyError with context. */
    function topologyError(message: string, cause: unknown): AmqpTopologyError {
        return new AmqpTopologyError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }

    /**
     * Apply declarative topology on a channel according to `topologyMode`.
     *
     * In `check` mode only existence is verifiable (checkExchange/checkQueue);
     * argument equivalence and bindings cannot be passively inspected (AMQP
     * has no introspection — a conflicting redeclare is PRECONDITION_FAILED).
     */
    async function applyTopology(ch: amqp.ConfirmChannel | amqp.Channel): Promise<void> {
        if (topologyMode === AmqpTopologyMode.SKIP) {
            return;
        }

        const topo = options.topology;

        if (topologyMode === AmqpTopologyMode.CHECK) {
            try {
                await ch.checkExchange(exchange);
                for (const ex of topo?.exchanges ?? []) {
                    await ch.checkExchange(ex.name);
                }
                for (const q of topo?.queues ?? []) {
                    await ch.checkQueue(q.name);
                }
            } catch (err) {
                throw topologyError("Topology check failed (missing broker object)", err);
            }
            return;
        }

        // assert mode
        try {
            await ch.assertExchange(exchange, exchangeType, {
                durable: options.exchangeOptions?.durable ?? true,
                autoDelete: options.exchangeOptions?.autoDelete ?? false,
            });

            for (const ex of topo?.exchanges ?? []) {
                await ch.assertExchange(ex.name, ex.type, {
                    durable: ex.durable ?? true,
                    autoDelete: ex.autoDelete ?? false,
                    arguments: ex.arguments,
                });
            }
            for (const q of topo?.queues ?? []) {
                await ch.assertQueue(q.name, {
                    durable: q.durable ?? true,
                    autoDelete: q.autoDelete ?? false,
                    exclusive: q.exclusive ?? false,
                    arguments: q.arguments,
                });
            }
            for (const b of topo?.bindings ?? []) {
                if (b.queue !== undefined) {
                    await ch.bindQueue(b.queue, b.source, b.routingKey, b.arguments);
                } else if (b.exchange !== undefined) {
                    await ch.bindExchange(b.exchange, b.source, b.routingKey, b.arguments);
                } else {
                    throw new Error(`Binding for source '${b.source}' must declare either 'queue' or 'exchange'`);
                }
            }
        } catch (err) {
            if (err instanceof AmqpTopologyError) {
                throw err;
            }
            throw topologyError("Topology declaration failed", err);
        }
    }

    /** Reject every pending mandatory-return record (connection lost). */
    function failPendingReturns(): void {
        pendingReturns.clear();
    }

    /**
     * (Re)create the publish channel with its `return` listener.
     * Called on every successful (re)connect via the recovery setup hook.
     */
    async function setupPublishChannel(model: amqp.ChannelModel): Promise<void> {
        const ch = await model.createConfirmChannel();

        ch.on("return", (msg: amqp.ConsumeMessage) => {
            const id = (msg.properties.headers as Record<string, unknown> | undefined)?.[PUBLISH_ID_HEADER];
            if (typeof id === "string") {
                const pending = pendingReturns.get(id);
                if (pending) {
                    pending.returned = true;
                }
                return;
            }
            // Single-flight mode: at most one mandatory publish is outstanding —
            // mark the only pending record.
            for (const pending of pendingReturns.values()) {
                pending.returned = true;
            }
        });

        ch.on("error", () => {
            // Channel-level errors surface through the connection lifecycle
            // and through rejected confirm callbacks; nothing to do here, but
            // the listener prevents unhandled 'error' crashes.
        });

        publishChannel = ch;
    }

    /** Start (or re-start after recovery) a consumer for a subscription record. */
    async function startConsumer(model: amqp.ChannelModel, record: SubscriptionRecord): Promise<void> {
        const group = record.subOptions?.group;
        const isAutoGroup = !group;
        const override: AmqpQueueOverride | undefined = group ? options.queueOverrides?.[group] : undefined;

        const ch = await model.createChannel();
        ch.on("error", () => {
            // Prevent unhandled 'error' events on consumer channels; failures
            // surface through recovery or through nacked deliveries.
        });

        const prefetch = options.consumerOptions?.prefetch ?? DEFAULT_PREFETCH;
        await ch.prefetch(prefetch);

        // Resolve queue name: explicit override → external contract queue;
        // named group → `${exchange}.${group}`; no group → exclusive auto queue.
        const queueName = override?.queue ?? (group ? `${exchange}.${group}` : `${exchange}.sub-${randomUUID()}`);

        // A queue declared in the explicit topology was already asserted with
        // its full arguments by applyTopology — re-asserting it here without
        // those arguments would be PRECONDITION_FAILED (406). Only bind.
        const declaredInTopology = options.topology?.queues?.some((q) => q.name === queueName) ?? false;

        if (topologyMode === AmqpTopologyMode.ASSERT && declaredInTopology) {
            try {
                for (const amqpPattern of record.patterns.map(toAmqpPattern)) {
                    await ch.bindQueue(queueName, exchange, amqpPattern);
                }
            } catch (err) {
                await ch.close().catch(() => undefined);
                throw topologyError(`Failed to bind topology-declared queue '${queueName}'`, err);
            }
        } else if (topologyMode === AmqpTopologyMode.ASSERT) {
            // Build queue arguments: global defaults + per-override arguments
            const queueArgs: Record<string, unknown> = {};
            if (options.queueOptions?.messageTtl !== undefined) {
                queueArgs["x-message-ttl"] = options.queueOptions.messageTtl;
            }
            if (options.queueOptions?.maxLength !== undefined) {
                queueArgs["x-max-length"] = options.queueOptions.maxLength;
            }
            if (options.queueOptions?.deadLetterExchange !== undefined) {
                queueArgs["x-dead-letter-exchange"] = options.queueOptions.deadLetterExchange;
            }
            if (options.queueOptions?.deadLetterRoutingKey !== undefined) {
                queueArgs["x-dead-letter-routing-key"] = options.queueOptions.deadLetterRoutingKey;
            }
            if (override?.arguments) {
                Object.assign(queueArgs, override.arguments);
            }

            const queueDurable = override?.durable ?? options.queueOptions?.durable ?? true;
            const exclusive = options.consumerOptions?.exclusive ?? false;

            try {
                await ch.assertQueue(queueName, {
                    durable: group ? queueDurable : false,
                    autoDelete: isAutoGroup,
                    exclusive: isAutoGroup ? exclusive : false,
                    arguments: Object.keys(queueArgs).length > 0 ? queueArgs : undefined,
                });

                for (const amqpPattern of record.patterns.map(toAmqpPattern)) {
                    await ch.bindQueue(queueName, exchange, amqpPattern);
                }
            } catch (err) {
                await ch.close().catch(() => undefined);
                throw topologyError(`Failed to declare queue '${queueName}'`, err);
            }
        } else if (topologyMode === AmqpTopologyMode.CHECK) {
            try {
                await ch.checkQueue(queueName);
            } catch (err) {
                await ch.close().catch(() => undefined);
                throw topologyError(`Queue '${queueName}' does not exist (topologyMode: "check")`, err);
            }
        }
        // skip mode: no checks — a missing queue fails on consume below.

        const decode = options.serialization?.decode;

        let consumeResult: amqp.Replies.Consume;
        try {
            consumeResult = await ch.consume(
                queueName,
                (msg: amqp.ConsumeMessage | null) => {
                    if (!msg) {
                        // Consumer cancelled by broker
                        return;
                    }

                    const msgHeaders = parseHeaders(msg.properties.headers as Record<string, unknown> | undefined);

                    const eventId = msgHeaders.get("x-event-id") ?? msg.properties.messageId ?? randomUUID();

                    const publishedAtStr = msgHeaders.get("x-published-at");
                    const publishedAt = publishedAtStr ? new Date(publishedAtStr) : msg.properties.timestamp ? new Date(msg.properties.timestamp * 1000) : new Date();

                    // Remove internal headers from metadata
                    msgHeaders.delete("x-event-id");
                    msgHeaders.delete("x-published-at");
                    msgHeaders.delete(PUBLISH_ID_HEADER);

                    let payload: Uint8Array;
                    try {
                        payload = decode ? decode(new Uint8Array(msg.content)) : new Uint8Array(msg.content);
                    } catch {
                        // Decode failure — reject without requeue (DLX or drop):
                        // a payload that cannot be decoded will never succeed.
                        ch.nack(msg, false, false);
                        return;
                    }

                    // Attempt: redelivered = at least 2nd delivery
                    const attempt = msg.fields.redelivered ? 2 : 1;

                    const rawEvent: RawEvent = {
                        eventId,
                        eventType: msg.fields.routingKey,
                        payload,
                        publishedAt: Number.isFinite(publishedAt.getTime()) ? publishedAt : new Date(),
                        attempt,
                        metadata: msgHeaders,
                    };

                    const ack = async (): Promise<void> => {
                        ch.ack(msg);
                    };
                    const nack = async (requeue?: boolean): Promise<void> => {
                        if (requeue === false) {
                            // Reject without requeue — goes to DLX or is discarded
                            ch.nack(msg, false, false);
                        } else {
                            // Reject with requeue
                            ch.nack(msg, false, true);
                        }
                    };

                    record.handler(rawEvent, ack, nack).catch(() => {
                        // Handler error — nack for redelivery
                        ch.nack(msg, false, true);
                    });
                },
                { noAck: false },
            );
        } catch (err) {
            await ch.close().catch(() => undefined);
            throw topologyError(`Failed to consume from queue '${queueName}'`, err);
        }

        record.channel = ch;
        record.consumerTag = consumeResult.consumerTag;
        record.queueName = queueName;
        record.isAutoGroup = isAutoGroup;
    }

    /**
     * Recovery setup hook: runs on EVERY successful (re)connect before the
     * wrapper reports the connection ready. Re-creates the publish channel,
     * re-applies topology, and replays active subscriptions.
     */
    async function onSetup(model: amqp.ChannelModel): Promise<void> {
        failPendingReturns();
        await setupPublishChannel(model);
        await applyTopology(publishChannel as amqp.ConfirmChannel);

        for (const record of subscriptionRecords) {
            if (record.active) {
                await startConsumer(model, record);
            }
        }
    }

    return {
        name: "amqp",

        async connect(context?: AdapterContext): Promise<void> {
            if (connection) {
                throw new AmqpConnectionError("AmqpAdapter: already connected");
            }
            closing = false;

            // Dynamic import to avoid top-level require issues with ESM
            const amqplib = await import("amqplib");

            const clientProperties: Record<string, string> = {};
            if (context?.serviceName) {
                clientProperties.connection_name = context.serviceName;
            }

            const recoveryEnabled = options.recovery !== false;
            const recoveryOpts = typeof options.recovery === "object" ? options.recovery : {};

            const connectOptions: Record<string, unknown> = {
                ...options.socketOptions,
            };
            if (Object.keys(clientProperties).length > 0) {
                connectOptions.clientProperties = clientProperties;
            }
            if (recoveryEnabled) {
                // amqplib opt-in recovery: reconnect with backoff+jitter; our
                // setup hook re-creates channels/topology/subscriptions.
                connectOptions.recovery = {
                    initialDelay: recoveryOpts.initialDelay,
                    maxDelay: recoveryOpts.maxDelay,
                    factor: recoveryOpts.factor,
                    jitter: recoveryOpts.jitter,
                    maxRetries: recoveryOpts.maxRetries,
                    setup: onSetup,
                };
            }

            const conn = (await amqplib.connect(options.url, connectOptions)) as amqp.ChannelModel;

            // Surface connection lifecycle; never console-only.
            conn.on("error", (err: Error) => {
                lifecycle?.onDisconnected?.(err);
            });

            if (recoveryEnabled) {
                conn.on("connect", () => {
                    lifecycle?.onConnected?.();
                });
                conn.on("disconnect", (err: Error) => {
                    failPendingReturns();
                    lifecycle?.onDisconnected?.(err);
                });
                conn.on("reconnect-scheduled", (info: { attempt: number; delay: number; error: Error }) => {
                    lifecycle?.onReconnecting?.(info);
                });
                conn.on("reconnect-failed", (err: Error) => {
                    publishChannel = null;
                    lifecycle?.onReconnectFailed?.(err);
                });

                // With recovery, the wrapper already ran onSetup before resolving.
                connection = conn;
                lifecycle?.onConnected?.();
                return;
            }

            // recovery: false — legacy single-shot connection.
            conn.on("close", () => {
                connection = null;
                publishChannel = null;
                failPendingReturns();
            });

            try {
                await onSetup(conn);
                connection = conn;
                lifecycle?.onConnected?.();
            } catch (err) {
                await conn.close().catch(() => undefined);
                publishChannel = null;
                throw err;
            }
        },

        async disconnect(): Promise<void> {
            closing = true;

            // Unsubscribe all active subscriptions first (with error isolation).
            for (const record of subscriptionRecords) {
                if (record.active && record.channel) {
                    if (record.consumerTag) {
                        await record.channel.cancel(record.consumerTag).catch(() => undefined);
                    }
                    if (record.isAutoGroup) {
                        await record.channel.deleteQueue(record.queueName).catch(() => undefined);
                    }
                    await record.channel.close().catch(() => undefined);
                }
                record.active = false;
                record.channel = null;
                record.consumerTag = null;
            }
            subscriptionRecords.length = 0;

            if (publishChannel) {
                await publishChannel.close().catch(() => undefined);
                publishChannel = null;
            }

            if (connection) {
                await connection.close().catch(() => undefined);
                connection = null;
            }
            failPendingReturns();
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            const ch = publishChannel;
            if (!ch || closing) {
                throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
            }

            const routingKey = eventType;
            const eventId = randomUUID();

            // Build headers: user metadata first, then internal
            const headers: Record<string, string> = {};

            if (publishOptions?.metadata) {
                for (const [key, value] of Object.entries(publishOptions.metadata)) {
                    // Skip only internal EventBus headers to prevent spoofing
                    if (key === "x-event-id" || key === "x-published-at" || key === PUBLISH_ID_HEADER) {
                        continue;
                    }
                    headers[key] = String(value);
                }
            }

            headers["x-event-id"] = eventId;
            headers["x-published-at"] = new Date().toISOString();

            const persistent = options.publisherOptions?.persistent ?? true;
            const mandatory = options.publisherOptions?.mandatory ?? false;

            let body: Buffer;
            try {
                const encode = options.serialization?.encode;
                const encoded = encode ? encode(payload) : payload;
                body = Buffer.from(encoded);
            } catch (err) {
                throw new AmqpSerializationError(`Payload encoding failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
            }

            // basic.return correlation (mandatory only): header stamping by
            // default; single-flight serialization when the header is disabled.
            // Frame ordering alone is NOT reliable — returns carry no
            // deliveryTag and confirms of other messages may interleave.
            const publishId: string | null = mandatory ? eventId : null;
            if (mandatory && correlationHeader) {
                headers[PUBLISH_ID_HEADER] = eventId;
            }

            const doPublish = async (): Promise<void> => {
                const pending: PendingReturn = { returned: false };
                if (publishId !== null) {
                    pendingReturns.set(publishId, pending);
                }

                try {
                    await new Promise<void>((resolve, reject) => {
                        let settled = false;
                        const settle = (fn: () => void): void => {
                            if (!settled) {
                                settled = true;
                                clearTimeout(timer);
                                fn();
                            }
                        };

                        const timer = setTimeout(() => {
                            settle(() =>
                                reject(new AmqpPublishTimeoutError(`No broker outcome within ${publishTimeoutMs}ms for routing key '${routingKey}' (message state UNKNOWN)`)),
                            );
                        }, publishTimeoutMs);

                        let written: boolean;
                        try {
                            written = ch.publish(
                                exchange,
                                routingKey,
                                body,
                                {
                                    persistent,
                                    mandatory,
                                    headers,
                                    contentType,
                                    messageId: eventId,
                                    timestamp: Math.trunc(Date.now() / 1000),
                                },
                                (err) => {
                                    // Per-message confirm callback (ack/nack). The broker
                                    // guarantees basic.return arrives BEFORE the confirm of
                                    // the same message — check the return flag first.
                                    settle(() => {
                                        if (err) {
                                            reject(
                                                closing || publishChannel !== ch
                                                    ? new AmqpConnectionError("Connection lost while awaiting publish confirm", { cause: err })
                                                    : new AmqpPublishNackError(`Broker nacked message for routing key '${routingKey}'`, { cause: err }),
                                            );
                                        } else if (pending.returned) {
                                            reject(new AmqpUnroutableError(`Message unroutable (mandatory): no queue bound for routing key '${routingKey}'`, routingKey));
                                        } else {
                                            resolve();
                                        }
                                    });
                                },
                            );
                        } catch (err) {
                            settle(() => reject(new AmqpConnectionError(`Publish failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })));
                            return;
                        }

                        // Back-pressure: the in-memory buffer is full. The confirm
                        // callback still fires; nothing extra to await here.
                        void written;
                    });
                } finally {
                    if (publishId !== null) {
                        pendingReturns.delete(publishId);
                    }
                }
            };

            // Confirms are always per-message: every publish resolves on its
            // own broker ack (or rejects with a typed error).
            if (mandatory && !correlationHeader) {
                // Single-flight: serialize mandatory publishes so the headerless
                // return frame is unambiguously the outstanding one.
                const run = mandatoryChain.then(doPublish, doPublish);
                mandatoryChain = run.catch(() => undefined);
                return run;
            }

            return doPublish();
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!connection) {
                throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
            }

            const record: SubscriptionRecord = {
                patterns,
                handler,
                subOptions,
                channel: null,
                consumerTag: null,
                queueName: "",
                isAutoGroup: !subOptions?.group,
                active: true,
            };

            await startConsumer(connection, record);
            subscriptionRecords.push(record);

            const subscription: EventSubscription = {
                async unsubscribe(): Promise<void> {
                    record.active = false;

                    const ch = record.channel;
                    if (ch) {
                        if (record.consumerTag) {
                            await ch.cancel(record.consumerTag).catch(() => undefined);
                        }

                        // Delete auto-generated queues to prevent broker-side leak
                        if (record.isAutoGroup) {
                            await ch.deleteQueue(record.queueName).catch(() => undefined);
                        }

                        // Do not unbind patterns for named groups — the queue is durable
                        // and shared across multiple consumers. Unbinding would break
                        // delivery to other active consumers on the same group.

                        await ch.close().catch(() => undefined);
                    }
                    record.channel = null;
                    record.consumerTag = null;

                    const idx = subscriptionRecords.indexOf(record);
                    if (idx !== -1) {
                        subscriptionRecords.splice(idx, 1);
                    }
                },
            };

            return subscription;
        },
    };
}

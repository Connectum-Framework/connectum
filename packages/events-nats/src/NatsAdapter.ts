/**
 * NATS JetStream adapter for `@connectum/events`.
 *
 * Implements the {@link EventAdapter} interface on top of NATS JetStream,
 * providing persistent at-least-once delivery with durable consumers
 * and wildcard-based topic matching.
 *
 * @module NatsAdapter
 */

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import { assertPublishTopic, assertSubscriptionPatterns } from "@connectum/events";
import type { ConsumerMessages, JetStreamClient, JetStreamManager, JsMsg } from "@nats-io/jetstream";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { connect, headers as createNatsHeaders } from "@nats-io/transport-node";
import type { ConsumerToRestore, RestoredConsumer } from "./consumerRecovery.ts";
import { recoverConsumer, restoreLostConsumer } from "./consumerRecovery.ts";
import { ensureConsumer } from "./consumerSetup.ts";
import { dispatchLifecycle, watchConnection } from "./lifecycle.ts";
import type { OwnedPattern } from "./patternOwner.ts";
import { comparePatterns, ownedPattern, runsHandler } from "./patternOwner.ts";
import { explainTimeout, showServers, showTopic, showTopics } from "./timeouts.ts";
import type { NatsAdapterOptions } from "./types.ts";
import { MS_TO_NS, validateAdapterOptions } from "./validateOptions.ts";

/** Default stream name when none is provided. */
const DEFAULT_STREAM = "events";

/** Default ack wait in nanoseconds (30 seconds). */
const DEFAULT_ACK_WAIT_NS = 30_000_000_000;

/** Wait `ms`, or until `signal` aborts; an abort ends the wait quietly. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
    try {
        await sleep(ms, undefined, { signal });
    } catch {
        // aborted: the caller checks the signal
    }
}

/** Pause before reading a recreated consumer is tried again after it failed. */
const REATTACH_RETRY_DELAY_MS = 1_000;

/** Default maximum delivery attempts. */
const DEFAULT_MAX_DELIVER = 5;

/** The header that carries the event id the adapter generated; a caller cannot set it through metadata. */
const EVENT_ID_HEADER = "x-event-id";

/**
 * Map a deliver-policy string to the NATS DeliverPolicy enum value.
 */
function toDeliverPolicy(policy: "new" | "all" | "last" | undefined): DeliverPolicy {
    switch (policy) {
        case "all":
            return DeliverPolicy.All;
        case "last":
            return DeliverPolicy.LastPerSubject;
        default:
            return DeliverPolicy.New;
    }
}

/**
 * Sanitize a string for use as a NATS JetStream durable consumer name.
 *
 * Durable names only allow `[a-zA-Z0-9_-]`. Any other characters
 * (dots, wildcards, special chars from user input) are replaced with `_`.
 */
function sanitizeDurableName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Derive a deterministic consumer name from the group and pattern.
 *
 * NATS durable consumer names must be alphanumeric plus `-` and `_`.
 * Both group and pattern are sanitized to ensure valid durable names.
 * A short SHA-256 hash suffix prevents collisions between inputs that
 * map to the same sanitized form (e.g. `orders.created` vs `orders_created`).
 */
export function consumerName(group: string, pattern: string): string {
    const safeGroup = sanitizeDurableName(group);
    const safePattern = sanitizeDurableName(pattern);
    const suffix = createHash("sha256").update(`${group}\0${pattern}`).digest("hex").slice(0, 8);
    return `${safeGroup}--${safePattern}--${suffix}`;
}

/**
 * Create a NATS JetStream adapter.
 *
 * @example
 * ```typescript
 * import { NatsAdapter } from "@connectum/events-nats";
 * import { createEventBus } from "@connectum/events";
 *
 * const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
 * const bus = createEventBus({ adapter, routes: [myRoutes] });
 * await bus.start();
 * ```
 */
export function NatsAdapter(options: NatsAdapterOptions): EventAdapter {
    validateAdapterOptions(options);

    const streamName = options.stream ?? DEFAULT_STREAM;

    let nc: NatsConnection | null = null;
    let js: JetStreamClient | null = null;
    let jsm: JetStreamManager | null = null;

    /** Set by disconnect(): the close that follows is our own and is not reported as a loss. */
    let closing = false;

    /** Active subscription handles for cleanup on disconnect. */
    const activeSubs: EventSubscription[] = [];

    return {
        name: "nats",

        async connect(context?: AdapterContext): Promise<void> {
            if (nc) {
                throw new Error("NatsAdapter: already connected");
            }

            const servers = Array.isArray(options.servers) ? options.servers : [options.servers];

            // Use serviceName as the NATS connection name (visible in /connz monitoring)
            // only when the user has not explicitly set connectionOptions.name.
            const name = options.connectionOptions?.name ?? context?.serviceName;

            let connection: NatsConnection;
            try {
                connection = await connect({
                    ...options.connectionOptions,
                    servers,
                    ...(name !== undefined && { name }),
                });
            } catch (err) {
                explainTimeout(err, `connect to ${showServers(servers)} did not complete in time`);
                throw err;
            }

            try {
                const jetStream = jetstream(connection);
                const manager = await jetstreamManager(connection);

                // Ensure the JetStream stream exists.
                try {
                    await manager.streams.info(streamName);
                } catch (err: unknown) {
                    // Only create the stream when it does not exist (JetStream API error 10059 / HTTP 404).
                    // Any other error (permissions, connectivity) must propagate.
                    const code = err && typeof err === "object" && "code" in err ? Number((err as { code?: number }).code) : undefined;
                    const apiErrCode = err && typeof err === "object" && "api_error" in err ? (err as { api_error?: { err_code?: number } }).api_error?.err_code : undefined;
                    if (code === 404 || code === 10059 || apiErrCode === 10059) {
                        await manager.streams.add({
                            name: streamName,
                            subjects: [`${streamName}.>`],
                        });
                    } else {
                        throw err;
                    }
                }

                // All setup succeeded — commit to closure-level state.
                nc = connection;
                js = jetStream;
                jsm = manager;
                closing = false;
            } catch (err) {
                explainTimeout(err, `preparing stream "${streamName}" on ${showServers(servers)} did not complete in time`);
                await connection.close().catch(() => undefined);
                throw err;
            }

            // Started only now: a connect() that failed above closed the connection itself, which is not a loss to report.
            const lifecycle = options.lifecycle;
            if (lifecycle?.onLifecycle !== undefined) {
                dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
                void watchConnection(
                    connection,
                    lifecycle,
                    () => closing,
                    () => {
                        // The client gave up and closed itself: drop the dead handles so publish() says "not connected"
                        // and connect() can start a fresh connection instead of refusing with "already connected".
                        if (nc === connection) {
                            nc = null;
                            js = null;
                            jsm = null;
                        }
                    },
                ).catch(() => undefined);
            }
        },

        async disconnect(): Promise<void> {
            closing = true;
            // Unsubscribe all active subscriptions first (with error isolation).
            const unsubResults = await Promise.allSettled([...activeSubs].map((sub) => sub.unsubscribe()));
            for (const r of unsubResults) {
                if (r.status === "rejected") {
                    console.error("[NatsAdapter] unsubscribe error:", r.reason);
                }
            }
            activeSubs.length = 0;

            if (nc) {
                await nc.drain();
                nc = null;
                js = null;
                jsm = null;
            }
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            // NATS has no empty subject token and answers one with "jetstream is not enabled".
            assertPublishTopic({ adapter: "NatsAdapter", topic: eventType });

            if (!js) {
                throw new Error("NatsAdapter: not connected");
            }

            const subject = `${streamName}.${eventType}`;

            // Always generate a fresh event-id — never accept from user metadata.
            const eventId = randomUUID();
            const headers = createNatsHeaders();
            headers.append(EVENT_ID_HEADER, eventId);

            // Merge user metadata into headers. Only the event id is the adapter's own: every other key,
            // including `x-*` ones and empty values, reaches the handler as it was given, as on the other adapters.
            const metadata = publishOptions?.metadata;
            if (metadata) {
                for (const [key, value] of Object.entries(metadata)) {
                    if (key !== EVENT_ID_HEADER) {
                        headers.append(key, String(value));
                    }
                }
            }

            try {
                await js.publish(subject, payload, { headers });
            } catch (err) {
                explainTimeout(err, `publish to topic ${showTopic(eventType)} on stream "${streamName}" was not acknowledged in time`);
                throw err;
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            // Before any consumer is created: a malformed pattern must not leave consumers of its
            // good neighbours behind, and the server would only answer "no responders" for it.
            assertSubscriptionPatterns({ adapter: "NatsAdapter", patterns });

            if (!js || !jsm) {
                throw new Error("NatsAdapter: not connected");
            }

            const isAutoGroup = !subOptions?.group;
            const group = subOptions?.group ?? `sub-${randomUUID().slice(0, 8)}`;

            // Whole nanoseconds: the server refuses a fraction, and a fractional millisecond count is a valid input.
            const ackWaitNs = options.consumerOptions?.ackWait !== undefined ? Math.round(options.consumerOptions.ackWait * MS_TO_NS) : DEFAULT_ACK_WAIT_NS;

            const maxDeliver = options.consumerOptions?.maxDeliver ?? DEFAULT_MAX_DELIVER;

            const deliverPolicy = toDeliverPolicy(options.consumerOptions?.deliverPolicy);

            const prefetch = options.consumerOptions?.prefetch;

            const redeliveryDelay = options.consumerOptions?.redeliveryDelay ?? 0;

            /** Tracked ConsumerMessages iterators for cleanup. */
            const messageIterators: ConsumerMessages[] = [];

            /** Every durable of the subscription, for the cleanup of an auto-generated group (on unsubscribe and when subscribe fails). */
            const durables: string[] = [];

            // Every pattern keeps its own durable consumer, so a message matched by several patterns
            // is delivered once per pattern. Which delivery runs the handler is decided per message by
            // the patterns' start sequences (see patternOwner), so all consumers are created and
            // their start sequences known before any loop starts.
            const unique = [...new Set(patterns)].sort(comparePatterns);
            const owned: OwnedPattern[] = [];

            // The consumer watches of the subscription: aborted first when the subscription ends, and awaited
            // before the auto-generated durables are deleted so that none is created again behind the delete.
            const watching = new AbortController();
            const watchers: Promise<void>[] = [];
            const manager = jsm;
            const client = js;
            const connection = nc;

            /** The stream (by its creation time) that each pattern's start bound belongs to; unset for the stream the subscription started on. */
            const boundStream: (string | undefined)[] = [];

            /**
             * Record the start bound of a consumer that exists again. A message matched by several patterns is
             * told apart by the start sequences of their consumers, and a consumer is only known to start where
             * the bound says: deferring a message to a consumer that starts later would lose it. After the stream
             * was created again, the bounds of the other patterns are of the old stream, and their consumers are
             * not recreated yet (or were created by another replica, starting anywhere), so they are set to "delivers
             * nothing known": until a pattern's own consumer is back, a delivery of another pattern runs the
             * handler itself, which can run it twice for an event and never zero times.
             */
            const adoptRestored = (index: number, pattern: string, restored: RestoredConsumer): void => {
                if (restored.streamReplaced) {
                    for (const [other, entry] of owned.entries()) {
                        if (other !== index && boundStream[other] !== restored.streamCreatedAt) {
                            owned[other] = ownedPattern(entry.pattern, Number.POSITIVE_INFINITY);
                        }
                    }
                }
                boundStream[index] = restored.streamCreatedAt;
                owned[index] = ownedPattern(pattern, restored.startSeq);
            };

            /**
             * Read one pattern's consumer: a message stream, the loop that runs the handler, and a watch that
             * brings the consumer back when the server loses it (the stream deleted and created again). After
             * the consumer is back the message stream is replaced: the client's own recovery waits for missed
             * heartbeats, tens of seconds, and delivers nothing meanwhile.
             */
            const startConsuming = async (slot: { readonly index: number; readonly pattern: string }): Promise<void> => {
                const { index, pattern } = slot;
                const durable = consumerName(group, pattern);
                const consumer = await client.consumers.get(streamName, durable);
                const info = await consumer.info(true);
                // The limit the server enforces, which for a consumer that already existed may differ from the requested one.
                const deliveryLimit = info.config.max_deliver ?? -1;
                // Without `prefetch` the client's own buffer size (100 messages) applies.
                const messages = await consumer.consume(prefetch === undefined ? undefined : { max_messages: prefetch });
                if (watching.signal.aborted) {
                    // The subscription ended while this consumer was being attached: nobody will close it later.
                    await discardUnread(messages);
                    return;
                }
                messageIterators[index] = messages;

                // Start the consumption loop in the background.
                // The loop exits when messages.close() is called.
                let lost = false;
                consumeLoop(messages, handler, { index, owned, consumerLost: () => lost }, streamName, { durable, streamName, redeliveryDelay, deliveryLimit }).catch((err) => {
                    console.error(`[EventBus/NATS] Consume loop error for pattern "${pattern}":`, err);
                });

                const toRestore: ConsumerToRestore = {
                    jsm: manager,
                    streamName,
                    config: { ...info.config, durable_name: durable },
                    createdAt: info.created,
                    isConnectionClosed: () => connection === null || connection.isClosed(),
                };
                watchers.push(
                    restoreLostConsumer(toRestore, messages, watching.signal, () => {
                        lost = true;
                    })
                        .then(async (first) => {
                            let restored = first;
                            if (restored === undefined) {
                                return;
                            }
                            await closeMessages(messages);
                            while (restored !== undefined && !watching.signal.aborted) {
                                adoptRestored(index, pattern, restored);
                                try {
                                    await startConsuming(slot);
                                    return;
                                } catch (err: unknown) {
                                    console.error(`[EventBus/NATS] Could not read the recreated consumer for pattern "${pattern}", trying again:`, err);
                                    await pause(REATTACH_RETRY_DELAY_MS, watching.signal);
                                    // The stream may have been deleted again meanwhile: make sure the consumer exists before reading it.
                                    restored = await recoverConsumer(toRestore, watching.signal);
                                }
                            }
                        })
                        .catch((err) => {
                            console.error(`[EventBus/NATS] Could not restore the consumer for pattern "${pattern}":`, err);
                        }),
                );
            };

            try {
                for (const pattern of unique) {
                    const durableName = consumerName(group, pattern);
                    durables.push(durableName);

                    const startSeq = await ensureConsumer(jsm, streamName, {
                        durable_name: durableName,
                        ack_policy: AckPolicy.Explicit,
                        deliver_policy: deliverPolicy,
                        filter_subject: `${streamName}.${pattern}`,
                        ack_wait: ackWaitNs,
                        max_deliver: maxDeliver,
                    });
                    owned.push(ownedPattern(pattern, startSeq));
                }

                for (const [index, own] of [...owned].entries()) {
                    await startConsuming({ index, pattern: own.pattern });
                }
            } catch (error) {
                watching.abort();
                // Partial rollback: close all previously created message iterators
                // to avoid leaked subscriptions when a later pattern fails.
                // Each close may wait up to CLOSE_CONFIRMATION_TIMEOUT_MS for an unresponsive server,
                // so the iterators close together: the rollback waits once, not once per pattern.
                await Promise.allSettled(messageIterators.map((iter) => closeMessages(iter)));
                await Promise.allSettled(watchers);
                // The durables of an auto-generated group belong to this call alone and are removed.
                // Those of a named group are shared with every replica of the group, and this call
                // cannot tell the ones it created from the ones another replica created at the same
                // moment (the server accepts an equal configuration as the same consumer); deleting a
                // consumer a replica reads stops its delivery without any error, so they are left in
                // place for the next, successful subscribe() of the group to attach to.
                if (isAutoGroup) {
                    for (const durableName of durables) {
                        await jsm.consumers.delete(streamName, durableName).catch(() => undefined);
                    }
                }
                messageIterators.length = 0;
                explainTimeout(error, `subscribe to topics ${showTopics(patterns)} on stream "${streamName}" did not complete in time`);
                throw error;
            }

            const subscription: EventSubscription = {
                async unsubscribe(): Promise<void> {
                    watching.abort();
                    // Closed together: each close may wait for the server's confirmation, and a
                    // subscription of several patterns must not wait once per pattern.
                    await Promise.all(messageIterators.map((iter) => closeMessages(iter)));
                    messageIterators.length = 0;
                    await Promise.allSettled(watchers);

                    // Delete auto-generated durable consumers to prevent broker-side leak.
                    if (isAutoGroup && jsm) {
                        for (const durableName of durables) {
                            await jsm.consumers.delete(streamName, durableName).catch(() => undefined);
                        }
                    }
                    durables.length = 0;

                    // Remove from the active subscriptions list.
                    const idx = activeSubs.indexOf(subscription);
                    if (idx !== -1) {
                        activeSubs.splice(idx, 1);
                    }
                },
            };

            activeSubs.push(subscription);
            return subscription;
        },
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse NATS message headers into a `Map<string, string>`.
 *
 * If a header has multiple values only the first is kept, matching
 * the single-value semantics of {@link RawEvent.metadata}.
 */
function parseHeaders(hdrs: { keys(): Iterable<string>; get(key: string): string } | undefined): Map<string, string> {
    const map = new Map<string, string>();
    if (!hdrs) {
        return map;
    }
    for (const key of hdrs.keys()) {
        const value = hdrs.get(key);
        if (value !== undefined) {
            map.set(key, value);
        }
    }
    return map;
}

/**
 * Longest wait for the server to confirm that a closing subscription is gone. It bounds the close
 * when the connection is down or reconnecting and the confirmation cannot come.
 */
const CLOSE_CONFIRMATION_TIMEOUT_MS = 5_000;

/**
 * Close a consumer's message stream without stranding a delivery.
 *
 * `ConsumerMessages.close()` forgets the underlying subscription on the spot and only then tells
 * the server. The server still holds the consumer's pull request until that message reaches it,
 * and a message it dispatches in between arrives for a subscription the client no longer knows:
 * it is dropped silently and stays awaiting an acknowledgement until `ack_wait` runs out, so the
 * next consumer of the group does not get it for the whole of `ack_wait`. Draining the
 * subscription first sends the unsubscribe, waits for the server to confirm it (a round trip
 * over the same connection, so every message sent before it has arrived by then) and keeps
 * receiving meanwhile: such a message reaches the consume loop and goes back through the handler,
 * which returns it to the group at once.
 *
 * The subscription is reached through the implementation class (`sub`), since the public
 * `ConsumerMessages` interface offers no draining close. Without it, or when the confirmation
 * does not come in time, this is the plain `close()`.
 */
function closeMessages(messages: ConsumerMessages): Promise<void> {
    // One close per message stream: a second caller (unsubscribe() twice, or disconnect()
    // overlapping it) waits for the first drain to be confirmed. Closing at once, because the
    // subscription is already draining, would forget it before the server confirmed the
    // unsubscribe and reopen the window in which a delivery is dropped.
    const running = closing.get(messages);
    if (running !== undefined) {
        return running;
    }
    const close = (async (): Promise<void> => {
        const subscription = (messages as { sub?: Subscription }).sub;
        if (subscription !== undefined && !subscription.isClosed() && !subscription.isDraining()) {
            const timer = new AbortController();
            await Promise.race([subscription.drain().catch(() => undefined), sleep(CLOSE_CONFIRMATION_TIMEOUT_MS, undefined, { signal: timer.signal }).catch(() => undefined)]);
            timer.abort();
        }
        await messages.close();
    })();
    closing.set(messages, close);
    const forget = (): void => {
        closing.delete(messages);
    };
    close.then(forget, forget);
    return close;
}

/** The close in progress of each message stream, shared by every caller of {@link closeMessages}. */
const closing = new WeakMap<ConsumerMessages, Promise<void>>();

/**
 * Close a message stream that no loop reads, handing back whatever it delivers meanwhile.
 *
 * `ConsumerMessages.close()` completes only when the stream is read to its end (measured against the
 * installed client: on a stream nobody reads it never settles), so closing an unread stream needs a reader.
 * A message that arrives in the meantime is given back at once, for the next consumer of the group.
 */
export async function discardUnread(messages: ConsumerMessages): Promise<void> {
    const reader = (async () => {
        for await (const msg of messages) {
            msg.nak();
        }
    })();
    await closeMessages(messages);
    await reader;
}

/** What the consume loop needs to know to give a message back to its consumer. */
interface Redelivery {
    /** The durable consumer and its stream, for the report. */
    readonly durable: string;
    readonly streamName: string;
    /** Pause in milliseconds before a handler failure is redelivered; `0` redelivers at once. */
    readonly redeliveryDelay: number;
    /** The consumer's `max_deliver` as the server holds it; `-1` is unlimited. */
    readonly deliveryLimit: number;
}

/**
 * Give a message back with `nak`, after `delayMs` when it is positive, and say so when this delivery
 * was the last one the consumer allows.
 *
 * The server stops redelivering at `max_deliver` and leaves the message in the stream, with nothing
 * logged on this side: without a delay the whole budget goes in milliseconds, and a poison message is
 * then simply stuck. The delivery counter is the server's own, so the report is exact for the
 * consumer that made the delivery.
 */
function returnForRedelivery(msg: JsMsg, topic: string, redelivery: Redelivery, delayMs: number): void {
    const { durable, streamName, deliveryLimit } = redelivery;
    if (deliveryLimit > 0 && msg.info.deliveryCount >= deliveryLimit) {
        console.error(
            `[EventBus/NATS] Message ${msg.seq} of topic "${topic}" was given back on delivery ${msg.info.deliveryCount}, which is the consumer's maxDeliver (${deliveryLimit}): ` +
                `consumer "${durable}" of stream "${streamName}" will not redeliver it again and it stays in the stream until retention removes it.`,
        );
    }
    if (delayMs > 0) {
        msg.nak(delayMs);
    } else {
        msg.nak();
    }
}

/**
 * Async consume loop that processes JetStream messages and
 * dispatches them through the provided handler.
 *
 * Real ack/nack callbacks are passed to the handler (C-1).
 * The EventBus layer handles auto-ack fallback if the handler
 * does not explicitly call ack() or nack().
 */
async function consumeLoop(
    messages: ConsumerMessages,
    handler: RawEventHandler,
    pattern: { readonly index: number; readonly owned: readonly OwnedPattern[]; readonly consumerLost: () => boolean },
    streamName: string,
    redelivery: Redelivery,
): Promise<void> {
    // The stream subject prefix to strip from delivered subjects.
    // publish() sends to `${streamName}.${eventType}`, so we strip `${streamName}.` to recover the original eventType.
    const subjectPrefix = `${streamName}.`;
    const { owned } = pattern;

    for await (const msg of messages) {
        // Strip the stream prefix so eventType matches what was originally published.
        const eventType = msg.subject.startsWith(subjectPrefix) ? msg.subject.slice(subjectPrefix.length) : msg.subject;

        // The pattern's entry is replaced when its consumer is created again, so it is read for every message.
        const own = owned[pattern.index] as OwnedPattern;

        // A more specific pattern of this subscription delivers this message too: that delivery
        // runs the handler, this one is settled without it.
        if (owned.length > 1 && !runsHandler(owned, own, eventType, msg.seq)) {
            // After a loss the sequence may name another message of the stream created again: leave it alone.
            if (!pattern.consumerLost()) {
                msg.ack();
            }
            continue;
        }

        const eventId = msg.headers?.get(EVENT_ID_HEADER) ?? randomUUID();

        // Convert nanoseconds to milliseconds safely (bigint or number).
        const tsNanos = msg.info.timestampNanos;
        const tsMs = typeof tsNanos === "bigint" ? Number(tsNanos / BigInt(MS_TO_NS)) : Math.trunc(tsNanos / MS_TO_NS);
        const publishedAt = Number.isFinite(tsMs) ? new Date(tsMs) : new Date();

        // The event id is its own field, not metadata.
        const metadata = parseHeaders(msg.headers);
        metadata.delete(EVENT_ID_HEADER);

        const event: RawEvent = {
            eventId,
            eventType,
            payload: msg.data,
            publishedAt,
            attempt: msg.info.deliveryCount,
            metadata,
        };

        // The first acknowledgement is final: the client ignores any later one, so a handler that settled the delivery
        // and then threw has nothing left to give back, and must not be reported as having used up its budget.
        let settled = false;
        // Once the server lost the consumer, an acknowledgement of this delivery names a stream sequence of the old stream.
        // The server matches it by sequence only, so it could settle a different message that the same sequence now
        // names in the stream created again (delivered to another replica of the group, or to this one later).
        const ack = async (): Promise<void> => {
            if (settled || pattern.consumerLost()) {
                return;
            }
            settled = true;
            msg.ack();
        };
        const nack = async (requeue?: boolean): Promise<void> => {
            if (settled || pattern.consumerLost()) {
                return;
            }
            settled = true;
            if (requeue === false) {
                msg.term();
            } else {
                // An explicit nack(true) is the handler's own decision and is not delayed.
                returnForRedelivery(msg, eventType, redelivery, 0);
            }
        };

        try {
            await handler(event, ack, nack);
        } catch {
            // Handler error — give an unsettled message back for redelivery, after the configured pause, and continue the loop.
            if (!settled && !pattern.consumerLost()) {
                returnForRedelivery(msg, eventType, redelivery, redelivery.redeliveryDelay);
            }
        }
    }
}

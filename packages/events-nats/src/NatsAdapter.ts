/**
 * NATS JetStream adapter for `@connectum/events`.
 *
 * Implements the {@link EventAdapter} interface on top of NATS JetStream,
 * providing persistent at-least-once delivery with durable consumers
 * and wildcard-based topic matching.
 *
 * @module NatsAdapter
 */

import { randomUUID } from "node:crypto";
import type { EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import type { ConsumerMessages, JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { connect, headers as createNatsHeaders } from "@nats-io/transport-node";
import type { NatsAdapterOptions } from "./types.ts";

/** Default stream name when none is provided. */
const DEFAULT_STREAM = "events";

/** Default ack wait in nanoseconds (30 seconds). */
const DEFAULT_ACK_WAIT_NS = 30_000_000_000;

/** Default maximum delivery attempts. */
const DEFAULT_MAX_DELIVER = 5;

/** Milliseconds-to-nanoseconds multiplier. */
const MS_TO_NS = 1_000_000;

/**
 * Map a deliver-policy string to the NATS DeliverPolicy enum value.
 */
function toDeliverPolicy(policy: "new" | "all" | "last" | undefined): DeliverPolicy {
    switch (policy) {
        case "all":
            return DeliverPolicy.All;
        case "last":
            return DeliverPolicy.Last;
        case "new":
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
 */
function consumerName(group: string, pattern: string): string {
    const safeGroup = sanitizeDurableName(group);
    const safePattern = sanitizeDurableName(pattern);
    return `${safeGroup}--${safePattern}`;
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
    const streamName = options.stream ?? DEFAULT_STREAM;

    let nc: NatsConnection | null = null;
    let js: JetStreamClient | null = null;
    let jsm: JetStreamManager | null = null;

    /** Active subscription handles for cleanup on disconnect. */
    const activeSubs: EventSubscription[] = [];

    return {
        name: "nats",

        async connect(): Promise<void> {
            const servers = Array.isArray(options.servers) ? options.servers : [options.servers];

            nc = await connect({
                ...options.connectionOptions,
                servers,
            });

            js = jetstream(nc);
            jsm = await jetstreamManager(nc);

            // Ensure the JetStream stream exists.
            try {
                await jsm.streams.info(streamName);
            } catch (err: unknown) {
                // Only create the stream when it does not exist (JetStream API error 10059 / HTTP 404).
                // Any other error (permissions, connectivity) must propagate.
                const apiErrCode = err && typeof err === "object" && "api_error" in err ? (err as { api_error: { err_code?: number } }).api_error?.err_code : undefined;
                if (apiErrCode === 10059) {
                    await jsm.streams.add({
                        name: streamName,
                        subjects: [`${streamName}.>`],
                    });
                } else {
                    throw err;
                }
            }
        },

        async disconnect(): Promise<void> {
            // Unsubscribe all active subscriptions first.
            for (const sub of activeSubs) {
                await sub.unsubscribe();
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
            if (!js) {
                throw new Error("NatsAdapter: not connected");
            }

            const subject = `${streamName}.${eventType}`;

            // Build NATS headers from metadata.
            const metadata = publishOptions?.metadata;

            if (metadata && Object.keys(metadata).length > 0) {
                await js.publish(subject, payload, {
                    headers: buildHeaders(metadata),
                });
            } else {
                await js.publish(subject, payload);
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!js || !jsm) {
                throw new Error("NatsAdapter: not connected");
            }

            const group = subOptions?.group ?? `sub-${randomUUID().slice(0, 8)}`;

            const ackWaitNs = options.consumerOptions?.ackWait ? options.consumerOptions.ackWait * MS_TO_NS : DEFAULT_ACK_WAIT_NS;

            const maxDeliver = options.consumerOptions?.maxDeliver ?? DEFAULT_MAX_DELIVER;

            const deliverPolicy = toDeliverPolicy(options.consumerOptions?.deliverPolicy);

            /** Tracked ConsumerMessages iterators for cleanup. */
            const messageIterators: ConsumerMessages[] = [];

            for (const pattern of patterns) {
                const subject = `${streamName}.${pattern}`;
                const durableName = consumerName(group, pattern);

                // Ensure consumer exists.
                await jsm.consumers.add(streamName, {
                    durable_name: durableName,
                    ack_policy: AckPolicy.Explicit,
                    deliver_policy: deliverPolicy,
                    filter_subject: subject,
                    ack_wait: ackWaitNs,
                    max_deliver: maxDeliver,
                });

                const consumer = await js.consumers.get(streamName, durableName);

                const messages = await consumer.consume();
                messageIterators.push(messages);

                // Start the consumption loop in the background.
                // The loop exits when messages.close() is called.
                consumeLoop(messages, handler, pattern, streamName).catch((err) => {
                    console.error(`[EventBus/NATS] Consume loop error for pattern "${pattern}":`, err);
                });
            }

            const subscription: EventSubscription = {
                async unsubscribe(): Promise<void> {
                    for (const iter of messageIterators) {
                        await iter.close();
                    }
                    messageIterators.length = 0;

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
 * Build NATS headers from a plain metadata record.
 */
function buildHeaders(metadata: Record<string, string>) {
    const hdrs = createNatsHeaders();
    for (const [key, value] of Object.entries(metadata)) {
        hdrs.append(key, value);
    }
    return hdrs;
}

/**
 * Parse NATS message headers into a `ReadonlyMap<string, string>`.
 *
 * If a header has multiple values only the first is kept, matching
 * the single-value semantics of {@link RawEvent.metadata}.
 */
function parseHeaders(hdrs: { keys(): Iterable<string>; get(key: string): string } | undefined): ReadonlyMap<string, string> {
    const map = new Map<string, string>();
    if (!hdrs) {
        return map;
    }
    for (const key of hdrs.keys()) {
        const value = hdrs.get(key);
        if (value !== undefined && value !== "") {
            map.set(key, value);
        }
    }
    return map;
}

/**
 * Async consume loop that processes JetStream messages and
 * dispatches them through the provided handler.
 *
 * Real ack/nack callbacks are passed to the handler (C-1).
 * The EventBus layer handles auto-ack fallback if the handler
 * does not explicitly call ack() or nack().
 */
async function consumeLoop(messages: ConsumerMessages, handler: RawEventHandler, _pattern: string, streamName: string): Promise<void> {
    // The stream subject prefix to strip from delivered subjects.
    // publish() sends to `${streamName}.${eventType}`, so we strip `${streamName}.` to recover the original eventType.
    const subjectPrefix = `${streamName}.`;

    for await (const msg of messages) {
        // Strip the stream prefix so eventType matches what was originally published.
        const eventType = msg.subject.startsWith(subjectPrefix) ? msg.subject.slice(subjectPrefix.length) : msg.subject;

        const event: RawEvent = {
            eventId: msg.headers?.get("event-id") ?? randomUUID(),
            eventType,
            payload: msg.data,
            publishedAt: new Date(msg.info.timestampNanos / MS_TO_NS),
            attempt: msg.info.deliveryCount,
            metadata: parseHeaders(msg.headers),
        };

        const ack = async (): Promise<void> => {
            msg.ack();
        };
        const nack = async (_requeue?: boolean): Promise<void> => {
            msg.nak();
        };

        await handler(event, ack, nack);
    }
}

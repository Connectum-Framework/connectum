/**
 * Getting a subscription's consumers back after the server lost them with their stream.
 *
 * Deleting a JetStream stream deletes its consumers. The client keeps asking for messages of a
 * consumer it knew and only tells the caller ("consumer deleted", "consumer not found", "stream not
 * found") that nothing will come: it does not create the consumer again. Without this module a
 * subscription stayed silent for good after the stream came back, while `publish()` worked again.
 *
 * A consumer deleted on its own, while its stream still exists, is a different case: an operator
 * removed it, and the adapter does not create it again behind their back. It is reported.
 *
 * @module consumerRecovery
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { ConsumerConfig, ConsumerMessages, ConsumerNotification, JetStreamManager } from "@nats-io/jetstream";
import { DeliverPolicy } from "@nats-io/jetstream";
import { ensureConsumer, isConsumerNotFound } from "./consumerSetup.ts";

/** First pause between attempts to bring the consumer back; it doubles up to {@link MAX_RETRY_DELAY_MS}. */
const FIRST_RETRY_DELAY_MS = 250;

/** Longest pause between attempts, so a stream that stays deleted for hours is polled, not hammered. */
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * The notifications of the client that say the consumer it reads from is gone. The client sends the
 * first when the server answers a pending request with "consumer deleted", the other two when its own
 * check of the consumer (after missed heartbeats) finds neither the consumer nor its stream.
 */
export function isConsumerLoss(status: ConsumerNotification): boolean {
    return status.type === "consumer_deleted" || status.type === "consumer_not_found" || status.type === "stream_not_found";
}

/**
 * An RFC 3339 timestamp as nanoseconds since the epoch. The server reports nine fractional digits and
 * `Date.parse()` keeps three, so a stream created within the same millisecond as the consumer would
 * compare equal to it. A timestamp that cannot be read counts as the epoch, which makes it compare as
 * not newer.
 */
export function nanosecondsOf(timestamp: string): bigint {
    const parts = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
    const wholeSeconds = parts === null ? Number.NaN : Date.parse(`${parts[1]}${parts[3]}`);
    if (parts === null || !Number.isFinite(wholeSeconds)) {
        return 0n;
    }
    return BigInt(wholeSeconds) * 1_000_000n + BigInt((parts[2] ?? "").padEnd(9, "0").slice(0, 9));
}

/** What recovery needs to know about one consumer of a subscription. */
export interface ConsumerToRestore {
    readonly jsm: JetStreamManager;
    readonly streamName: string;
    /** The consumer's configuration as the server held it, from which the replacement is built. */
    readonly config: ConsumerConfig & { durable_name: string };
    /** When the consumer was created, as the server reported it. A stream created after that moment replaced the stream the consumer belonged to. */
    readonly createdAt: string;
    /** Whether the connection is closed for good (the client gave up reconnecting, or `disconnect()` ran): recovery stops. */
    readonly isConnectionClosed: () => boolean;
}

/** A consumer that exists again. */
export interface RestoredConsumer {
    /** The first stream sequence the consumer delivers, as `ensureConsumer` bounds it. */
    readonly startSeq: number;
    /** Whether the stream is a different one from the stream the consumer was lost with (its sequences start again). */
    readonly streamReplaced: boolean;
    /** When the stream the consumer belongs to was created, as the server reported it; it tells the streams of two recoveries apart. */
    readonly streamCreatedAt: string;
}

/**
 * Bring a lost consumer back, waiting for its stream while it is missing, until the consumer exists,
 * the consumer turns out to have been deleted on its own, or `signal` aborts.
 */
export async function recoverConsumer(consumer: ConsumerToRestore, signal: AbortSignal): Promise<RestoredConsumer | undefined> {
    const where = `consumer "${consumer.config.durable_name}" of stream "${consumer.streamName}"`;
    let delay = FIRST_RETRY_DELAY_MS;
    let reported = false;
    while (!signal.aborted) {
        if (consumer.isConnectionClosed()) {
            // The client gave up on the server for good: nothing more can be asked of it, and a retry would never end.
            console.error(`[EventBus/NATS] The connection is closed, so ${where} cannot be created again; this subscription receives no further events.`);
            return undefined;
        }
        try {
            const stream = await consumer.jsm.streams.info(consumer.streamName);
            // A stream created after the consumer cannot be the one the consumer belonged to.
            const streamReplaced = nanosecondsOf(stream.created) > nanosecondsOf(consumer.createdAt);
            if (!streamReplaced) {
                // The stream is the old one. Either another replica created the consumer again, which this one attaches to,
                // or an operator deleted it, which is not undone.
                try {
                    await consumer.jsm.consumers.info(consumer.streamName, consumer.config.durable_name);
                } catch (err: unknown) {
                    if (!isConsumerNotFound(err)) {
                        throw err;
                    }
                    console.error(
                        `[EventBus/NATS] ${where} was deleted while its stream still exists. The adapter does not create it again: this subscription receives no further events until it is subscribed again.`,
                    );
                    return undefined;
                }
            }
            if (signal.aborted) {
                // The subscription ended during the requests above: a consumer created now would outlive it.
                return undefined;
            }
            if (!reported && streamReplaced) {
                reported = true;
                console.error(`[EventBus/NATS] The server lost ${where} together with its stream, which exists again. Creating the consumer again.`);
            }
            const { durable_name, ack_policy, filter_subject, ack_wait, max_deliver, deliver_policy } = consumer.config;
            const startSeq = await ensureConsumer(consumer.jsm, consumer.streamName, {
                durable_name,
                ack_policy,
                ...(filter_subject !== undefined && { filter_subject }),
                ...(ack_wait !== undefined && { ack_wait }),
                ...(max_deliver !== undefined && { max_deliver }),
                // Every message of a stream that was created again was published after the loss, so none was delivered before.
                deliver_policy: streamReplaced ? DeliverPolicy.All : deliver_policy,
            });
            console.warn(`[EventBus/NATS] ${where} exists again; delivery resumes.`);
            return { startSeq, streamReplaced, streamCreatedAt: stream.created };
        } catch {
            // The stream is not back yet, or the server cannot be reached: say so once, wait and ask again.
            if (!reported) {
                reported = true;
                console.error(
                    `[EventBus/NATS] The server lost ${where} and its stream is not available. No event will arrive until the stream exists; waiting for it and then creating the consumer again.`,
                );
            }
            try {
                await sleep(delay, undefined, { signal });
            } catch {
                // aborted: the loop condition ends the wait
            }
            delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
        }
    }
    return undefined;
}

/**
 * Watch one consumer of a subscription and bring it back when the server lost it with its stream.
 *
 * It handles one loss: the client's message stream does not deliver from the new consumer for tens
 * of seconds (it waits for missed heartbeats), so the caller replaces the message stream with a new
 * one and watches that. A report is never dropped: when another replica created the consumer first,
 * `ensureConsumer` attaches to that one, and the caller still has to replace the dead message stream.
 *
 * @returns The restored consumer, or `undefined` when the consumer was deleted on its own (reported),
 * or the message stream closed or `signal` aborted first.
 */
export async function restoreLostConsumer(
    consumer: ConsumerToRestore,
    messages: ConsumerMessages,
    signal: AbortSignal,
    onLoss: () => void = () => undefined,
): Promise<RestoredConsumer | undefined> {
    for await (const status of messages.status()) {
        if (signal.aborted) {
            return undefined;
        }
        if (isConsumerLoss(status)) {
            onLoss();
            return recoverConsumer(consumer, signal);
        }
    }
    return undefined;
}

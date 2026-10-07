/**
 * Batch consumption with offset commits driven by ack/nack.
 *
 * @module consumeBatch
 */

import { randomUUID } from "node:crypto";
import type { RawEvent, RawEventHandler } from "@connectum/events";
import type { EachBatchPayload, IHeaders } from "kafkajs";

/**
 * Parse a timestamp from header string or Kafka numeric timestamp.
 * Returns current time if both are missing or invalid.
 */
function parseTimestamp(headerValue: string | undefined, kafkaTimestamp: string | undefined): Date {
    if (headerValue) {
        const d = new Date(headerValue);
        if (Number.isFinite(d.getTime())) return d;
    }
    if (kafkaTimestamp) {
        const n = Number(kafkaTimestamp);
        if (Number.isFinite(n)) return new Date(n);
    }
    return new Date();
}

/**
 * Parse Kafka message headers into a Map<string, string>.
 *
 * KafkaJS headers can contain Buffer, string, or arrays thereof.
 * This normalizes all values to strings.
 */
function parseHeaders(headers: IHeaders | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!headers) {
        return result;
    }

    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            // Take the first element for simplicity
            const [first] = value;
            if (first !== undefined) {
                result.set(key, Buffer.isBuffer(first) ? first.toString("utf-8") : String(first));
            }
        } else {
            result.set(key, Buffer.isBuffer(value) ? value.toString("utf-8") : String(value));
        }
    }

    return result;
}

/**
 * Heartbeat interval of the consumer, in milliseconds. The adapter passes it to KafkaJS and to
 * {@link createBatchConsumer}, so the interval KafkaJS enforces and the one the handler timer
 * works from cannot drift apart. It equals the KafkaJS default.
 */
export const defaultHeartbeatIntervalMs = 3_000;

/** Dependencies of {@link createBatchConsumer}. */
export interface BatchConsumerOptions {
    /** Receives every message together with its settlement callbacks. */
    readonly handler: RawEventHandler;
    /**
     * Heartbeat interval KafkaJS runs with, in milliseconds. While a handler runs the batch
     * callback tries to heartbeat twice per interval: `heartbeat()` of KafkaJS sends nothing
     * until a whole interval has passed since the previous request, so a tick period equal to
     * the interval could skip a beat and double the real gap.
     */
    readonly heartbeatInterval: number;
    /** Milliseconds a partition stays paused after a message was left uncommitted; 0 disables the pause. */
    readonly redeliveryDelay: number;
    /** Pending partition resumes, owned by the caller so it can cancel them on unsubscribe. */
    readonly resumeTimers: Set<NodeJS.Timeout>;
}

/**
 * Build the KafkaJS `eachBatch` callback.
 *
 * Offsets are driven entirely by ack/nack(false). The consumer must run with
 * `autoCommit: false` and `eachBatchAutoResolve: false`: KafkaJS then never commits
 * on its own and returning from the callback does not mark the batch as consumed.
 * Only settled messages advance the position, so the next fetch starts at the first
 * unsettled message and redelivers it together with the rest of the batch, in
 * partition order.
 */
export function createBatchConsumer(options: BatchConsumerOptions): (payload: EachBatchPayload) => Promise<void> {
    const { handler, heartbeatInterval, redeliveryDelay, resumeTimers } = options;
    const heartbeatTickMs = heartbeatInterval / 2;

    return async ({ batch, resolveOffset, commitOffsetsIfNecessary, heartbeat, isRunning, pause }: EachBatchPayload): Promise<void> => {
        const lastIndex = batch.messages.length - 1;
        for (const [index, message] of batch.messages.entries()) {
            // Shutdown in progress: leave the remaining messages unsettled so the
            // group's next consumer receives them.
            if (!isRunning()) break;

            const msgHeaders = parseHeaders(message.headers);

            // Extract event ID from headers or use message key/offset
            const eventId = msgHeaders.get("x-event-id") ?? message.key?.toString("utf-8") ?? randomUUID();

            const publishedAt = parseTimestamp(msgHeaders.get("x-published-at"), message.timestamp);

            // Kafka does not natively track delivery attempts across redeliveries.
            // Attempt defaults to 1; retry middleware tracks retries internally.
            const attempt = 1;

            // Remove internal headers from metadata
            msgHeaders.delete("x-event-id");
            msgHeaders.delete("x-published-at");

            const rawEvent: RawEvent = {
                eventId,
                eventType: batch.topic,
                payload: message.value ? new Uint8Array(message.value) : new Uint8Array(),
                publishedAt,
                attempt,
                metadata: msgHeaders,
            };

            // A Kafka offset is a high-water mark: committing offset N declares every
            // earlier message of the partition consumed. Settlement is therefore
            // strictly ordered — the first message that is not committed ends the
            // batch, and it is the first one fetched again.
            let committed = false;
            let requeued = false;
            let open = true;
            let commitError: unknown;
            let commitInFlight: Promise<void> | undefined;

            const commit = async (): Promise<void> => {
                // The last message also covers trailing control records that
                // never reach the handler, so the group does not stall on them.
                const consumedOffset = index === lastIndex ? batch.lastOffset() : message.offset;
                const nextOffset = (BigInt(consumedOffset) + 1n).toString();
                try {
                    // Explicit offsets are committed unconditionally; the argument-less
                    // form only commits on an interval or threshold, which is not set.
                    await commitOffsetsIfNecessary({ topics: [{ topic: batch.topic, partitions: [{ partition: batch.partition, offset: nextOffset }] }] });
                    resolveOffset(message.offset);
                    committed = true;
                } catch (err) {
                    commitError = err;
                    throw err;
                }
            };

            // The first settlement wins; calls after the handler's turn are ignored so a
            // late ack cannot move the offset past messages that were never processed.
            const ack = async (): Promise<void> => {
                if (!open || requeued) return;
                if (commitInFlight === undefined) {
                    commitInFlight = commit();
                    // A handler may fire ack() without awaiting it; the failure is
                    // rethrown after the turn, so it must not surface as unhandled here.
                    commitInFlight.catch(() => undefined);
                }
                await commitInFlight;
            };
            const nack = async (requeue?: boolean): Promise<void> => {
                if (requeue === false) {
                    // "Reject without requeue" — commit the offset so the message
                    // is not redelivered. DLQ middleware already saved a copy.
                    await ack();
                    return;
                }
                if (!open || commitInFlight !== undefined) return;
                requeued = true;
            };

            // KafkaJS has no background heartbeat: it only beats when this callback asks. A handler
            // that outlives the session timeout would drop out of the group and every later
            // commit would fail with "The coordinator is not aware of this member". The timer lives
            // exactly as long as the handler's turn; one heartbeat at a time, and the first failure
            // stops it and is kept for the decision after the turn.
            let heartbeatFailure: { readonly error: unknown } | undefined;
            let heartbeatInFlight: Promise<void> | undefined;
            const heartbeatTimer = setInterval(() => {
                if (heartbeatInFlight !== undefined) return;
                heartbeatInFlight = heartbeat()
                    .catch((error: unknown) => {
                        heartbeatFailure = { error };
                        clearInterval(heartbeatTimer);
                    })
                    .finally(() => {
                        heartbeatInFlight = undefined;
                    });
            }, heartbeatTickMs);

            try {
                await handler(rawEvent, ack, nack);
            } catch (err) {
                // What decides redelivery is whether the message was committed before the
                // handler threw. The error itself is only reported, so a failing handler
                // is visible in the service log instead of silently looping.
                console.error(`[KafkaAdapter] handler error for ${batch.topic}[${batch.partition}]@${message.offset}:`, err);
            } finally {
                clearInterval(heartbeatTimer);
            }
            open = false;

            if (commitInFlight !== undefined) {
                await commitInFlight.catch(() => undefined);
            }
            // A heartbeat still on the wire settles before the outcome is decided, so its failure
            // is not missed; the promise never rejects (the failure is recorded above).
            await heartbeatInFlight;
            // A failed commit is surfaced to KafkaJS so it can rejoin the group
            // (rebalance) or restart the consumer from the last committed offset.
            if (commitError !== undefined) throw commitError;

            // Not committed — handler threw, nack(true), or returned without
            // settling. Stop here: the message and the rest of the batch are
            // fetched again, preserving order.
            if (!committed) {
                // The member was dropped (or is being rebalanced) while the handler ran: redelivering
                // on that membership would fail again, so hand the failure to KafkaJS to rejoin.
                if (heartbeatFailure !== undefined) throw heartbeatFailure.error;
                if (redeliveryDelay > 0) {
                    const resume = pause();
                    const timer = setTimeout(() => {
                        resumeTimers.delete(timer);
                        resume();
                    }, redeliveryDelay);
                    timer.unref();
                    resumeTimers.add(timer);
                }
                break;
            }
            await heartbeat();
        }
    };
}

/**
 * Creating or attaching to the durable consumer of one pattern, and finding out from which stream
 * sequence on that consumer delivers messages.
 *
 * @module consumerSetup
 */

import type { ConsumerConfig, ConsumerInfo, JetStreamManager } from "@nats-io/jetstream";

/**
 * Consumer metadata key holding the first stream sequence the consumer delivers. Written once, when
 * the adapter creates the consumer or attaches for the first time to one created by an earlier
 * version, so that every replica of the group reads the same value.
 */
export const START_SEQ_METADATA = "connectum.start_seq";

/** Set once the first metadata write was refused, so the warning is printed once per process. */
let startSeqRecordWarned = false;

/**
 * Make sure the durable described by `config` exists and return the first stream sequence it delivers.
 *
 * A consumer this call creates is appended to `created` (a later failure removes it again) and
 * starts wherever `deliver_policy` puts it. An existing consumer delivers everything above its
 * acknowledgement floor, or, before its first acknowledgement, everything above what it has
 * delivered so far; both are at or above the sequence it started at, so another consumer never
 * skips a message in favour of this one unless this one delivers it. The bound is written to the
 * consumer's metadata the first time, so later subscribers and other replicas skip the same
 * deliveries instead of each reading a floor that has moved on.
 *
 * Two replicas may both find the consumer missing and both try to create it. The loser is refused
 * because the winner has meanwhile written the metadata, so the loser reads the consumer again and
 * continues as with one that existed before; it is not appended to `created`.
 */
export async function ensureConsumer(jsm: JetStreamManager, streamName: string, config: Partial<ConsumerConfig> & { durable_name: string }, created: string[]): Promise<number> {
    let info: ConsumerInfo | undefined;
    try {
        info = await jsm.consumers.info(streamName, config.durable_name);
    } catch (err: unknown) {
        if (!isConsumerNotFound(err)) {
            throw err;
        }
    }

    if (info === undefined) {
        try {
            const fresh = await jsm.consumers.add(streamName, config);
            created.push(config.durable_name);
            const startSeq = fresh.delivered.stream_seq + 1;
            await recordStartSeq(jsm, streamName, config.durable_name, fresh.config.metadata, startSeq);
            return startSeq;
        } catch (err: unknown) {
            if (!isConsumerAlreadyExists(err)) {
                throw err;
            }
            info = await jsm.consumers.info(streamName, config.durable_name);
        }
    }

    const recorded = Number(info.config.metadata?.[START_SEQ_METADATA]);
    if (Number.isSafeInteger(recorded) && recorded > 0) {
        return recorded;
    }
    const startSeq = (info.ack_floor.stream_seq > 0 ? info.ack_floor.stream_seq : info.delivered.stream_seq) + 1;
    await recordStartSeq(jsm, streamName, config.durable_name, info.config.metadata, startSeq);
    return startSeq;
}

/**
 * Write the start sequence into the consumer's metadata. Consumer metadata needs nats-server 2.10;
 * on an older server (the package supports 2.9) the client refuses the field, and the adapter then
 * works from the bound it computed: correctness does not depend on the record, only the number of
 * repeated handler runs when replicas compute different bounds. The refusal is reported once.
 */
async function recordStartSeq(jsm: JetStreamManager, streamName: string, durableName: string, metadata: Record<string, string> | undefined, startSeq: number): Promise<void> {
    try {
        await jsm.consumers.update(streamName, durableName, { metadata: { ...metadata, [START_SEQ_METADATA]: String(startSeq) } });
    } catch (err: unknown) {
        if (!startSeqRecordWarned) {
            startSeqRecordWarned = true;
            console.warn(
                `[EventBus/NATS] cannot record the start sequence of consumer "${durableName}" (server older than 2.10?): replicas may handle an event twice when they attach at different times.`,
                err,
            );
        }
    }
}

/** JetStream API error code: the consumer does not exist. */
const CONSUMER_NOT_FOUND = 10014;

/** JetStream API error code: a consumer of that name exists with a different configuration. */
const CONSUMER_ALREADY_EXISTS = 10148;

/** The JetStream API error code (`JetStreamApiError.code`) of `err`, if it carries one. */
function apiErrorCode(err: unknown): number | undefined {
    if (!err || typeof err !== "object" || !("code" in err)) {
        return undefined;
    }
    const code = Number((err as { code: unknown }).code);
    return Number.isFinite(code) ? code : undefined;
}

/** Whether `err` is the JetStream "consumer not found" API error. A missing stream is a different error and is not matched. */
export function isConsumerNotFound(err: unknown): boolean {
    return apiErrorCode(err) === CONSUMER_NOT_FOUND;
}

/** Whether `err` is the JetStream refusal to create a consumer that exists with a different configuration. */
export function isConsumerAlreadyExists(err: unknown): boolean {
    return apiErrorCode(err) === CONSUMER_ALREADY_EXISTS;
}

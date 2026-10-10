/**
 * Creating or attaching to the durable consumer of one pattern, and finding out from which stream
 * sequence on that consumer delivers messages.
 *
 * The adapter only ever reads an existing consumer: it never updates its configuration. A
 * consumer's configuration is compared by the server when an earlier version of this adapter
 * creates it again on start-up, so any field this version added (such as metadata) would make
 * that version fail with "consumer already exists" and block a rollback.
 *
 * @module consumerSetup
 */

import type { ConsumerConfig, ConsumerInfo, JetStreamManager } from "@nats-io/jetstream";

/**
 * Make sure the durable described by `config` exists and return a bound on the first stream
 * sequence it delivers: never below the sequence the consumer started at, so another consumer of
 * the subscription never leaves a message to this one unless this one delivers it.
 *
 * A consumer this call creates starts wherever `deliver_policy` puts it, and the bound is exact.
 * For an existing consumer the bound is its acknowledgement floor plus one (everything below is
 * acknowledged and will not be delivered again), or, while nothing has been acknowledged yet,
 * what it has delivered so far plus one. The second bound can be above a delivery that is still
 * unacknowledged and will come again; the consume loop therefore runs the handler for every
 * delivery below the bound of the consumer that made it (see `runsHandler`). The bound is not
 * written anywhere: replicas that compute different bounds can run the handler twice for a
 * message, never zero times.
 *
 * Two replicas may both find the consumer missing and both try to create it. With equal
 * configurations the second creation is accepted as the same consumer; with different ones
 * (for example during a rollout that changes `ackWait`) it is refused as "already exists", and
 * the loser reads the consumer again and continues as with one that existed before.
 */
export async function ensureConsumer(jsm: JetStreamManager, streamName: string, config: Partial<ConsumerConfig> & { durable_name: string }): Promise<number> {
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
            return fresh.delivered.stream_seq + 1;
        } catch (err: unknown) {
            if (!isConsumerAlreadyExists(err)) {
                throw err;
            }
            info = await jsm.consumers.info(streamName, config.durable_name);
        }
    }

    warnOnConfigurationDrift(streamName, info, config);
    return (info.ack_floor.stream_seq > 0 ? info.ack_floor.stream_seq : info.delivered.stream_seq) + 1;
}

/** Consumers already reported by this process, so a consumer that stays different is reported once. */
const reportedDrift = new Set<string>();

/**
 * Report an existing consumer whose delivery settings differ from the ones this subscription asks
 * for. The adapter keeps the existing configuration (see the module comment); an earlier version
 * failed here with "consumer already exists" on nats-server 2.10 and later, so a changed
 * `ackWait` or `maxDeliver` would otherwise go on running with the old values without a word.
 */
function warnOnConfigurationDrift(streamName: string, existing: ConsumerInfo, requested: Partial<ConsumerConfig> & { durable_name: string }): void {
    const key = `${streamName}/${requested.durable_name}`;
    if (reportedDrift.has(key)) {
        return;
    }
    const differences: string[] = [];
    for (const field of ["ack_wait", "max_deliver", "deliver_policy"] as const) {
        const wanted = requested[field];
        if (wanted !== undefined && existing.config[field] !== wanted) {
            differences.push(`${field}=${String(existing.config[field])} (requested ${String(wanted)})`);
        }
    }
    if (differences.length === 0) {
        return;
    }
    reportedDrift.add(key);
    console.warn(`[EventBus/NATS] consumer "${requested.durable_name}" of stream "${streamName}" exists with ${differences.join(", ")}; the existing configuration is kept.`);
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

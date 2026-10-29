/**
 * Keep a wildcard subscription alive when a topic it matched is deleted.
 *
 * KafkaJS keeps the topic list a consumer was given and offers no way to drop a topic from it. After
 * a matched topic is deleted the consumer crashes on the next fetch, the library restarts it with the
 * same list, and every restart fails on the topic that is gone: the healthy topics of the subscription
 * deliver nothing until some unrelated refresh of the library's metadata happens to clear the state
 * (about five minutes in a measured run). The only way to drop a topic is a new consumer, so this
 * module replaces the crashed one with a consumer subscribed to the topics that still exist.
 *
 * @module topicRecovery
 */

import type { Consumer } from "kafkajs";
import type { ConsumerCrashPayload } from "./lifecycle.ts";
import { isUnknownTopic as isUnknownTopicError } from "./subscribeTopics.ts";

/** What {@link createTopicRecovery} needs from the subscription it keeps alive. */
export interface TopicRecoveryOptions {
    /**
     * Create a consumer of the subscription's group with its event listeners attached.
     * The crash listener it registers must forward the payload to `onCrash`.
     */
    readonly createConsumer: (onCrash: (payload: ConsumerCrashPayload) => void) => Consumer;
    /** The literal topic names of the subscription; they are subscribed again as they are. */
    readonly literals: readonly string[];
    /** The wildcard patterns of the subscription, as matchers over topic names. */
    readonly wildcards: readonly RegExp[];
    /** The topics on the broker the subscription has seen; replaced by the current list after a recovery. */
    readonly known: Set<string>;
    /**
     * The topics that were on the broker when the subscription started; never changed afterwards.
     * A surviving topic that is not in it was found later and was subscribed from its beginning,
     * so the replacement subscribes it from its beginning too: a partition of it may have no
     * committed offset yet, and reading from the end would skip messages that were never settled.
     */
    readonly started: ReadonlySet<string>;
    /** Whether topics the group has no offset for are read from their beginning. */
    readonly fromBeginning: boolean;
    /**
     * Whether the subscription follows new topics (topic discovery is on). When it does not, its topic
     * list is fixed, and the replacement keeps it fixed: a matching topic created since the start is
     * not subscribed.
     */
    readonly discover: boolean;
    /** The configuration the consumer is started with. */
    readonly runConfig: Parameters<Consumer["run"]>[0];
    /** Pending partition resumes of the subscription; they belong to the replaced consumer and are dropped. */
    readonly resumeTimers: Set<NodeJS.Timeout>;
    /** Names of all topics on the broker. */
    readonly listTopics: () => Promise<string[]>;
    /** Milliseconds before a recovery that failed half-way is tried again. Default: 5000. */
    readonly retryDelay?: number;
    /** Subscribe a consumer that is not running to topics; the subscription's own handling of missing topics goes here. */
    readonly subscribe: (consumer: Consumer, topics: readonly string[], fromBeginning: boolean) => Promise<void>;
}

/** The recovery of one subscription. */
export interface TopicRecovery {
    /** Create the subscription's first consumer, or the next one after a recovery. */
    readonly spawn: () => Consumer;
    /**
     * The consumer that is current, as the three calls topic discovery needs. Discovery holds this
     * instead of a consumer, so it follows a replacement.
     */
    readonly current: Pick<Consumer, "stop" | "subscribe" | "run">;
    /** Run `task` after every task queued before it; recovery and discovery never overlap. */
    readonly serialize: <T>(task: () => Promise<T>) => Promise<T>;
    /** Stop recovering and disconnect the current consumer. Resolves after a recovery under way has finished. */
    readonly close: () => Promise<void>;
}

const defaultRetryDelayMs = 5_000;

/**
 * Watch the consumers of one subscription and replace a crashed one whose topic list names a topic
 * that no longer exists.
 *
 * A crash is acted on only when the broker's answer was "unknown topic" and the broker's topic list
 * confirms that a topic matched by a wildcard is gone; any other crash stays with the library's own
 * restarts. The replacement subscribes the literal topics and the wildcard matches that still exist,
 * reading topics that appeared meanwhile from their first message (they are new to the group, as in
 * topic discovery). A recovery that fails half-way is repeated after `retryDelay`.
 */
export function createTopicRecovery(options: TopicRecoveryOptions): TopicRecovery {
    const { createConsumer, literals, wildcards, known, started, fromBeginning, runConfig, resumeTimers, listTopics, subscribe } = options;
    const retryDelay = options.retryDelay ?? defaultRetryDelayMs;

    let consumer: Consumer | undefined;
    let closed = false;
    let retryTimer: NodeJS.Timeout | undefined;
    let queue: Promise<unknown> = Promise.resolve();

    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task, task);
        queue = result.catch(() => undefined);
        return result;
    };

    const matchesWildcard = (name: string): boolean => wildcards.some((wildcard) => wildcard.test(name));

    function spawn(): Consumer {
        const created: Consumer = createConsumer((payload) => {
            // The library schedules its own restart right after this listener returns; queueing the
            // recovery behind it means disconnect() below cancels that restart instead of racing it.
            if (created === consumer && !closed && wildcards.length > 0 && isUnknownTopicError(payload.error)) {
                void serialize(() => recover(created, false)).catch((err: unknown) => {
                    console.error("[KafkaAdapter] topic recovery failed:", err);
                });
            }
        });
        consumer = created;
        return created;
    }

    /** Try the recovery again from `from`, a consumer that a failed recovery left disconnected. */
    function scheduleRetry(from: Consumer): void {
        if (closed) {
            return;
        }
        retryTimer = setTimeout(() => {
            void serialize(() => recover(from, true)).catch((err: unknown) => {
                console.error("[KafkaAdapter] topic recovery failed:", err);
            });
        }, retryDelay);
        retryTimer.unref();
    }

    async function recover(source: Consumer, retrying: boolean): Promise<void> {
        if (closed || source !== consumer) {
            return;
        }
        let names: string[];
        try {
            names = await listTopics();
        } catch (err) {
            console.error("[KafkaAdapter] topic recovery: listing topics failed:", err);
            // The library's own restart loop crashes again and asks again; a consumer already replaced by a failed recovery has no such loop.
            if (retrying) {
                scheduleRetry(source);
            }
            return;
        }
        if (closed || source !== consumer) {
            return;
        }
        const existing = new Set(names);
        const gone = [...known].filter((name) => matchesWildcard(name) && !existing.has(name));
        // A retry of a recovery that failed half-way has no consumer running and must start one even if the deleted topic came back meanwhile.
        if (gone.length === 0 && !retrying) {
            return;
        }

        console.warn(
            `[KafkaAdapter] topic recovery: ${gone.length} topic(s) matching a wildcard no longer exist (${gone.join(", ")}); replacing the consumer with one subscribed to the remaining topics`,
        );
        for (const pending of resumeTimers) {
            clearTimeout(pending);
        }
        resumeTimers.clear();
        // Also cancels the restart the library scheduled for the crashed consumer.
        await source.disconnect().catch((err: unknown) => {
            console.error("[KafkaAdapter] topic recovery: disconnecting the crashed consumer failed:", err);
        });
        if (closed) {
            return;
        }

        const matching = names.filter(matchesWildcard);
        const survivors = matching.filter((name) => known.has(name) && started.has(name));
        // Found after the start (by discovery or an earlier recovery) or created meanwhile: read from the first message.
        const fresh = matching.filter((name) => (known.has(name) ? !started.has(name) : options.discover) && !literals.includes(name));
        const next = spawn();
        try {
            await next.connect();
            await subscribe(next, [...new Set([...literals, ...survivors])], fromBeginning);
            if (fresh.length > 0) {
                await next.subscribe({ topics: fresh, fromBeginning: true });
            }
            await next.run(runConfig);
        } catch (err) {
            console.error(`[KafkaAdapter] topic recovery failed; will retry in ${retryDelay} ms:`, err);
            await next.disconnect().catch(() => undefined);
            scheduleRetry(next);
            return;
        }
        // Updated only now: a recovery that failed half-way must still see the deleted topics as gone.
        // Topics left out of the subscription (new ones, with discovery off) stay unknown.
        const unsubscribed = new Set(options.discover ? [] : matching.filter((name) => !known.has(name)));
        known.clear();
        for (const name of names) {
            if (!unsubscribed.has(name)) {
                known.add(name);
            }
        }
    }

    return {
        spawn,
        current: {
            stop: () => (consumer as Consumer).stop(),
            subscribe: (subscription) => (consumer as Consumer).subscribe(subscription),
            run: (config) => (consumer as Consumer).run(config),
        },
        serialize,
        async close() {
            closed = true;
            clearTimeout(retryTimer);
            await queue;
            await consumer?.disconnect();
        },
    };
}

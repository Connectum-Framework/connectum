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

/** What the recovery needs a consumer of the subscription to call. */
export interface ConsumerHooks {
    /**
     * Called with every crash of the consumer. Returns the payload to report: a crash the recovery
     * takes over is reported as one the subscription will recover from, because it will.
     */
    readonly onCrash: (payload: ConsumerCrashPayload) => ConsumerCrashPayload;
    /**
     * The consumer's `retry.restartOnFailure`. The library asks it before it schedules a restart of the
     * crashed consumer; the recovery answers `false` when it replaces the consumer itself, so the
     * library never starts the old consumer again beside its replacement.
     */
    readonly restartOnFailure: (error: Error) => Promise<boolean>;
}

/** What {@link createTopicRecovery} needs from the subscription it keeps alive. */
export interface TopicRecoveryOptions {
    /**
     * Create a consumer of the subscription's group with its event listeners attached.
     * The crash listener it registers must pass the payload to `onCrash` and report what `onCrash`
     * returns, and the consumer must be created with `restartOnFailure` as its `retry.restartOnFailure`.
     */
    readonly createConsumer: (hooks: ConsumerHooks) => Consumer;
    /** The literal topic names of the subscription; they are subscribed again as they are. */
    readonly literals: readonly string[];
    /** The wildcard patterns of the subscription, as matchers over topic names. */
    readonly wildcards: readonly RegExp[];
    /** The topics on the broker the subscription has seen; replaced by the current list after a recovery. */
    readonly known: Set<string>;
    /**
     * The topics that were on the broker when the subscription started; only the topics found deleted are removed from it
     * (a topic created again under the same name is a new topic to the group).
     * A surviving topic that is not in it was found later and was subscribed from its beginning,
     * so the replacement subscribes it from its beginning too: a partition of it may have no
     * committed offset yet, and reading from the end would skip messages that were never settled.
     */
    readonly started: Set<string>;
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

    /** The last crash of each consumer, read right after a replacement was started to see whether its start failed. */
    const lastCrash = new WeakMap<Consumer, Error>();

    /**
     * Topics the question to the library found gone. The replacement lists the topics again, and a topic
     * that was created again in between must still count as deleted: it is a new topic to the group.
     */
    const confirmedGone = new Set<string>();

    /** Consumers whose start the recovery is waiting for; their start failures are retried by the recovery, not final. */
    const starting = new WeakSet<Consumer>();

    /** Whether the broker's topic list shows that a topic a wildcard had matched is gone. A failed listing counts as no. */
    async function matchedTopicIsGone(): Promise<boolean> {
        try {
            const existing = new Set(await listTopics());
            const gone = [...known].filter((name) => matchesWildcard(name) && !existing.has(name));
            for (const name of gone) {
                confirmedGone.add(name);
            }
            return gone.length > 0;
        } catch (err) {
            // The consumer is restarted by the library, crashes again and asks again.
            console.error("[KafkaAdapter] topic recovery: listing topics failed:", err);
            return false;
        }
    }

    function spawn(): Consumer {
        /** Set when the library was told not to restart this consumer because the recovery replaces it. */
        let takenOver = false;
        const created: Consumer = createConsumer({
            restartOnFailure: async (error) => {
                // A consumer of a closed subscription, or one that has been replaced, is never started again.
                if (created !== consumer || closed) {
                    return false;
                }
                if (wildcards.length === 0 || !isUnknownTopicError(error)) {
                    return true;
                }
                // Decided before the library schedules anything: a restart that was already scheduled
                // could fire while the topics are being listed, and a consumer that is still starting
                // ignores a stop, so it would run on beside its replacement.
                const gone = await matchedTopicIsGone();
                // The listing took time: the subscription may have been closed or the consumer replaced meanwhile.
                if (created !== consumer || closed) {
                    return false;
                }
                if (!gone) {
                    return true;
                }
                takenOver = true;
                return false;
            },
            onCrash: (payload) => {
                lastCrash.set(created, payload.error);
                // A start that fails while the recovery waits for it is tried again by the recovery, whatever the library will do.
                if (starting.has(created)) {
                    return { ...payload, restart: true };
                }
                if (!takenOver) {
                    return payload;
                }
                takenOver = false;
                void serialize(() => recover(created)).catch((err: unknown) => {
                    console.error("[KafkaAdapter] topic recovery failed:", err);
                });
                return { ...payload, restart: true };
            },
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
            void serialize(() => recover(from)).catch((err: unknown) => {
                console.error("[KafkaAdapter] topic recovery failed:", err);
            });
        }, retryDelay);
        retryTimer.unref();
    }

    /**
     * Replace `source`, a consumer that crashed (or whose replacement failed) and that the library does
     * not restart. A consumer is always started, even when the deleted topic is back by now: nothing
     * else would start one.
     */
    async function recover(source: Consumer): Promise<void> {
        if (closed || source !== consumer) {
            return;
        }
        let names: string[];
        try {
            names = await listTopics();
        } catch (err) {
            console.error("[KafkaAdapter] topic recovery: listing topics failed:", err);
            // The library will not restart this consumer, so nothing but the retry brings the subscription back.
            scheduleRetry(source);
            return;
        }
        if (closed || source !== consumer) {
            return;
        }
        const existing = new Set(names);
        const gone = [...known].filter((name) => matchesWildcard(name) && !existing.has(name));

        console.warn(
            gone.length > 0
                ? `[KafkaAdapter] topic recovery: ${gone.length} topic(s) matching a wildcard no longer exist (${gone.join(", ")}); replacing the consumer with one subscribed to the remaining topics`
                : "[KafkaAdapter] topic recovery: starting a replacement consumer",
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
        for (const name of [...gone, ...confirmedGone]) {
            started.delete(name);
        }
        const survivors = matching.filter((name) => known.has(name) && started.has(name));
        // Found after the start (by discovery or an earlier recovery) or created meanwhile: read from the first message.
        const fresh = matching.filter((name) => (known.has(name) ? !started.has(name) : options.discover) && !literals.includes(name));
        const next = spawn();
        starting.add(next);
        try {
            await next.connect();
            await subscribe(next, [...new Set([...literals, ...survivors])], fromBeginning);
            if (fresh.length > 0) {
                await next.subscribe({ topics: fresh, fromBeginning: true });
            }
            await next.run(runConfig);
            // run() resolves although the start failed (for example GROUP_AUTHORIZATION_FAILED): the library reports
            // such a failure as a crash of the consumer and returns. The subscription is not recovered by that.
            const startFailure = lastCrash.get(next);
            if (startFailure !== undefined) {
                throw startFailure;
            }
        } catch (err) {
            console.error(`[KafkaAdapter] topic recovery failed; will retry in ${retryDelay} ms:`, err);
            await next.disconnect().catch(() => undefined);
            scheduleRetry(next);
            return;
        } finally {
            starting.delete(next);
        }
        confirmedGone.clear();
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

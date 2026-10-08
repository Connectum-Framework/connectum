/**
 * Pick up topics created after a wildcard subscription started.
 *
 * KafkaJS expands a RegExp subscription into topic names once, in `subscribe()`, and its
 * consumer group joins with that fixed list. A matching topic created later is invisible to
 * it until the consumer is stopped, told about the topic and run again. The Java client
 * refreshes pattern subscriptions on its own; this module does the same by polling the
 * broker's topic list.
 *
 * @module topicDiscovery
 */

import type { Consumer } from "kafkajs";

/** What {@link startTopicDiscovery} needs from the subscription it watches. */
export interface TopicDiscoveryOptions {
    /** Consumer of the subscription; it is stopped and run again when a new topic appears. */
    readonly consumer: Consumer;
    /** The wildcard patterns of the subscription, as matchers over topic names. */
    readonly wildcards: readonly RegExp[];
    /** Topics the consumer is already subscribed to; grows as topics are discovered. */
    readonly known: Set<string>;
    /** The configuration the consumer was started with, passed to `run()` again after a restart. */
    readonly runConfig: Parameters<Consumer["run"]>[0];
    /** Pending partition resumes of the subscription; they belong to the stopped consumer and are dropped on restart. */
    readonly resumeTimers: Set<NodeJS.Timeout>;
    /** Milliseconds between two checks. */
    readonly interval: number;
    /** Names of all topics on the broker. */
    readonly listTopics: () => Promise<string[]>;
}

/**
 * Start checking for new topics every `interval` milliseconds.
 *
 * @returns A function that stops the checks and resolves once a check or restart that is
 *          already under way has finished, so the caller can disconnect the consumer safely.
 */
export function startTopicDiscovery(options: TopicDiscoveryOptions): () => Promise<void> {
    const { consumer, wildcards, known, runConfig, resumeTimers, interval, listTopics } = options;

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let current: Promise<void> = Promise.resolve();
    /** Whether the consumer is running; false after a restart that failed half-way. */
    let running = true;

    async function check(): Promise<void> {
        const fresh = (await listTopics()).filter((name) => !known.has(name) && wildcards.some((wildcard) => wildcard.test(name)));
        if (stopped || (fresh.length === 0 && running)) {
            return;
        }

        // The consumer being stopped paused partitions of its own; their resumes mean nothing to the next one.
        for (const pending of resumeTimers) {
            clearTimeout(pending);
        }
        resumeTimers.clear();

        if (running) {
            running = false;
            await consumer.stop();
        }
        // The subscription was closed while the consumer was stopping: nothing is left to restart.
        if (stopped) {
            return;
        }
        if (fresh.length > 0) {
            // A topic that appeared after the subscription is new to the group, so everything in
            // it is newer than the subscription: start from its first message, or the messages
            // published between its creation and this check would be skipped.
            await consumer.subscribe({ topics: [...fresh], fromBeginning: true });
            for (const name of fresh) {
                known.add(name);
            }
        }
        if (!stopped) {
            await consumer.run(runConfig);
            running = true;
        }
    }

    function schedule(): void {
        if (stopped) {
            return;
        }
        timer = setTimeout(() => {
            current = check()
                .catch((err: unknown) => {
                    console.error("[KafkaAdapter] topic discovery failed; will retry:", err);
                })
                .finally(schedule);
        }, interval);
        timer.unref();
    }

    schedule();

    return async () => {
        stopped = true;
        clearTimeout(timer);
        await current;
    };
}

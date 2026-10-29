/**
 * Subscribing a consumer to topics that may not exist yet.
 *
 * @module subscribeTopics
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { Consumer } from "kafkajs";

/** How long, and how often, to look again for a topic the broker is creating on request. */
export interface TopicCreationWait {
    readonly timeoutMs: number;
    readonly pollMs: number;
}

/**
 * How long a subscription waits for the broker to create a missing topic when `allowAutoTopicCreation` is on.
 * The broker creates the topic after answering the first metadata request with "unknown topic"; on a single
 * node that takes well under a second, so ten seconds leaves room for a loaded cluster.
 */
export const defaultTopicCreationWait: TopicCreationWait = { timeoutMs: 10_000, pollMs: 250 };

/** Whether a client error, or one of its causes, is the broker's answer "no such topic". */
function isUnknownTopic(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
        if ((current as { type?: unknown }).type === "UNKNOWN_TOPIC_OR_PARTITION") {
            return true;
        }
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

/**
 * Subscribe `consumer` to `topics`, and say which topics a refusal was about.
 *
 * The broker answers a metadata request for a topic it does not have with "This server does not host
 * this topic-partition" and, if the request allowed it, starts creating the topic in the same moment.
 * The client library treats that answer as final, so with `allowAutoTopicCreation` the subscription
 * failed on the first attempt although the topic existed a moment later. With the option on, the
 * subscription therefore asks again until the topic is there or `wait.timeoutMs` has passed. Without
 * it, or when the topic does not appear in time, the error names the literal topics of the
 * subscription (the answer itself does not) and keeps the original as its `cause`. Wildcard patterns
 * are expanded from the topics that exist, so they never fail this way.
 */
export async function subscribeToTopics(options: {
    readonly consumer: Pick<Consumer, "subscribe">;
    readonly topics: readonly (string | RegExp)[];
    readonly fromBeginning: boolean;
    readonly allowAutoTopicCreation: boolean;
    readonly wait?: TopicCreationWait;
}): Promise<void> {
    const { consumer, topics, fromBeginning, allowAutoTopicCreation, wait = defaultTopicCreationWait } = options;
    const deadline = Date.now() + wait.timeoutMs;
    for (;;) {
        try {
            await consumer.subscribe({ topics: [...topics], fromBeginning });
            return;
        } catch (err) {
            if (!isUnknownTopic(err)) {
                throw err;
            }
            if (allowAutoTopicCreation && Date.now() < deadline) {
                await sleep(wait.pollMs);
                continue;
            }
            const names = topics.filter((topic): topic is string => typeof topic === "string").map((topic) => JSON.stringify(topic));
            const advice = allowAutoTopicCreation
                ? `The broker did not create it within ${wait.timeoutMs} ms; check that it allows automatic topic creation (auto.create.topics.enable), or create the topic first.`
                : "Create the topic before subscribing, or set consumerOptions.allowAutoTopicCreation to true to have the broker create it.";
            throw new Error(`KafkaAdapter: cannot subscribe to topic ${names.join(", ")}: the broker does not have it. ${advice}`, { cause: err });
        }
    }
}

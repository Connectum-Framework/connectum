/**
 * Messages for client timeouts that say nothing about what timed out.
 *
 * The NATS client reports a request that got no answer as `TimeoutError: timeout`, after 5 s for a
 * JetStream request and 20 s for the connection. The message names neither the topic nor the
 * servers, so a service that publishes to several topics or dials several servers leaves the operator
 * guessing.
 *
 * @module timeouts
 */

/** Characters of a topic shown in a message; a longer one is cut and its length given. */
const SHOWN_TOPIC_CHARS = 100;

/** Topics listed in a message before the rest are counted. */
const SHOWN_TOPICS = 5;

/** A topic as it appears in an error message: quoted, and cut when it is longer than {@link SHOWN_TOPIC_CHARS}. */
export function showTopic(topic: string): string {
    const shown = topic.length > SHOWN_TOPIC_CHARS ? `${topic.slice(0, SHOWN_TOPIC_CHARS)}... (${topic.length} characters)` : topic;
    return JSON.stringify(shown);
}

/** Several topics as a bracketed list; beyond the first few only their number is given. */
export function showTopics(topics: readonly string[]): string {
    const listed = topics.slice(0, SHOWN_TOPICS).map(showTopic);
    if (topics.length > SHOWN_TOPICS) {
        listed.push(`and ${topics.length - SHOWN_TOPICS} more`);
    }
    return `[${listed.join(", ")}]`;
}

/**
 * Servers as they appear in an error message, without the credentials that a URL may carry
 * (`nats://user:password@host:4222`, `nats://token@host:4222`): an error message is logged and shipped
 * to places a password must not reach.
 */
export function showServers(servers: readonly string[]): string {
    // Up to the last "@" before the path: a password may contain an "@" that is not escaped, and the client's URL parser reads the last one as the separator.
    return servers.map((server) => server.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/]*@/i, "$1")).join(", ");
}

/**
 * Put what was being done in front of the message of a client timeout.
 *
 * The message is rewritten in place, so the error keeps its class (`TimeoutError`), its name and its
 * `cause`; callers that test for it keep working. The original text stays at the end. Any other error is
 * left alone: only a timeout lacks the facts that every other error of the client carries. An error
 * already explained is not explained twice.
 */
export function explainTimeout(error: unknown, action: string): void {
    if (error instanceof Error && error.name === "TimeoutError" && !error.message.startsWith("NatsAdapter:")) {
        error.message = `NatsAdapter: ${action}: ${error.message}`;
    }
}

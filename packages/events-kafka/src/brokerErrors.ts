/**
 * Messages for broker and socket failures that the client library reports without the facts needed to act on them.
 *
 * @module brokerErrors
 */

/** How deep the `cause` chain of a client error is followed; the library nests a retry wrapper around the failure, a few levels at most. */
const maxChainDepth = 5;

/** What the client library puts in front of the socket's own text; empty text after it means the socket gave none. */
const emptyConnectionMessage = /^Connection error:\s*$/;

/** The errors of a `cause` chain, outermost first. */
function chainOf(error: unknown): Error[] {
    const chain: Error[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < maxChainDepth && current instanceof Error; depth++) {
        chain.push(current);
        current = current.cause;
    }
    return chain;
}

/**
 * Give a connection failure the reason the client library lost.
 *
 * When a host name resolves to several addresses and every one refuses, Node raises an
 * `AggregateError` whose own message is empty; the client library builds its message from it and
 * ends up with `Connection error: ` and nothing after the colon, so the operator learns neither why
 * nor where. The error still carries the socket's error code and the broker address, which are
 * enough to restore the text a single-address failure has (`connect ECONNREFUSED 127.0.0.1:1`).
 *
 * The messages are rewritten in place, on the connection error and on the wrappers that copied its
 * text, so the error keeps its class, its `cause` chain and every field callers may test; only an
 * empty reason is ever touched.
 */
export function explainConnectionError(error: unknown): void {
    const chain = chainOf(error);
    const connection = chain.find((link) => link.name === "KafkaJSConnectionError") as (Error & { broker?: unknown; code?: unknown }) | undefined;
    if (connection === undefined) {
        return;
    }
    const broker = typeof connection.broker === "string" ? connection.broker : undefined;
    const code = typeof connection.code === "string" ? connection.code : undefined;
    const reason =
        code !== undefined
            ? `connect ${code}${broker !== undefined ? ` ${broker}` : ""}`
            : `connection${broker !== undefined ? ` to ${broker}` : ""} failed, the socket gave no reason`;
    for (const link of chain) {
        if (emptyConnectionMessage.test(link.message)) {
            link.message = `Connection error: ${reason}`;
        }
    }
}

/**
 * Longest Kafka topic name and the characters it may hold, as the broker enforces them (a 249-character name
 * is accepted and a 250-character one refused; a space, `*` and non-ASCII letters are refused).
 */
const topicNameRule = 'Kafka topic names may contain only ASCII letters, digits, ".", "_" and "-" and are at most 249 characters long';

/**
 * Name the topic in a publish failure the broker answers with `INVALID_TOPIC_EXCEPTION`.
 *
 * The broker's answer ("The request attempted to perform an operation on an invalid topic") does not
 * say which topic, and a service that publishes to several leaves the operator guessing. Any other
 * failure is returned as it is.
 *
 * @returns A new error that carries the original as its `cause`, or `error` itself.
 */
export function explainInvalidTopic(topic: string, error: unknown): unknown {
    if (!chainOf(error).some((link) => (link as { type?: unknown }).type === "INVALID_TOPIC_EXCEPTION")) {
        return error;
    }
    return new Error(`KafkaAdapter: the broker refused to publish to topic ${JSON.stringify(topic)} as invalid. ${topicNameRule}.`, { cause: error });
}

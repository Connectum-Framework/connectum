/**
 * How the adapter reacts to what a real server answers when it looks for, creates and re-creates a
 * durable consumer: the error shapes it must recognise, and a second replica losing the race to
 * create the same consumer.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server; see OverlappingPatterns.integration.test.ts.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { JetStreamManager } from "@nats-io/jetstream";
import { AckPolicy, DeliverPolicy, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { ensureConsumer, isConsumerAlreadyExists, isConsumerNotFound } from "../../src/consumerSetup.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function uniqueName(prefix: string): string {
    return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

describe("NATS adapter: consumer set-up against a real server", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    async function withStream<T>(run: (jsm: JetStreamManager, stream: string) => Promise<T>): Promise<T> {
        const connection = await connect({ servers });
        try {
            const jsm = await jetstreamManager(connection);
            const stream = uniqueName("cs");
            await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] });
            try {
                return await run(jsm, stream);
            } finally {
                await jsm.streams.delete(stream).catch(() => undefined);
            }
        } finally {
            await connection.close();
        }
    }

    /** nats-server 2.9 accepts creating an existing consumer again with another configuration; 2.10 and later refuse. */
    async function refusesRecreation(): Promise<boolean> {
        const connection = await connect({ servers });
        try {
            const [major = 0, minor = 0] = (connection.info?.version ?? "0.0.0").split(".").map(Number);
            return major > 2 || (major === 2 && minor >= 10);
        } finally {
            await connection.close();
        }
    }

    const config = (stream: string, ackWaitNs: number) => ({
        durable_name: "dur",
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        filter_subject: `${stream}.a.>`,
        ack_wait: ackWaitNs,
        max_deliver: 5,
    });

    it("recognises a missing consumer", async () => {
        await withStream(async (jsm, stream) => {
            const error = await jsm.consumers.info(stream, "absent").catch((e: unknown) => e);
            assert.ok(error instanceof Error);
            assert.equal(isConsumerNotFound(error), true);
            assert.equal(isConsumerAlreadyExists(error), false);
        });
    });

    it("recognises the refusal to create an existing consumer with another configuration", async () => {
        const refuses = await refusesRecreation();
        await withStream(async (jsm, stream) => {
            await jsm.consumers.add(stream, config(stream, 30_000_000_000));
            const error = await jsm.consumers.add(stream, config(stream, 60_000_000_000)).catch((e: unknown) => e);
            if (!refuses) {
                assert.ok(!(error instanceof Error), "this server accepts the second add");
                return;
            }
            assert.ok(error instanceof Error, "the second add is refused");
            assert.equal(isConsumerAlreadyExists(error), true, `unrecognised error: ${(error as Error).message}`);
            assert.equal(isConsumerNotFound(error), false);
        });
    });

    it("a replica that loses the race to create the consumer attaches to the winner's and creates nothing", async () => {
        const refuses = await refusesRecreation();
        await withStream(async (jsm, stream) => {
            await jsm.consumers.add(stream, config(stream, 30_000_000_000));
            // The loser asked before the winner created the consumer, so its lookup said "not found".
            let first = true;
            const stale = new Proxy(jsm, {
                get(target, prop, receiver) {
                    if (prop !== "consumers") {
                        return Reflect.get(target, prop, receiver);
                    }
                    return new Proxy(target.consumers, {
                        get(consumers, method) {
                            if (method === "info") {
                                return async (s: string, name: string) => {
                                    if (first) {
                                        first = false;
                                        const notFound = Object.assign(new Error("consumer not found"), { code: 10014, status: 404 });
                                        throw notFound;
                                    }
                                    return consumers.info(s, name);
                                };
                            }
                            const value = Reflect.get(consumers, method);
                            return typeof value === "function" ? value.bind(consumers) : value;
                        },
                    });
                },
            });
            const created: string[] = [];
            const startSeq = await ensureConsumer(stale, stream, config(stream, 60_000_000_000), created);
            assert.equal(startSeq, 1, "nothing was published: the winner's consumer delivers from the start");
            // A server older than 2.10 takes the second add as an update of the same consumer, so there the
            // caller does count as its creator; newer servers refuse it and the caller attaches instead.
            assert.deepEqual(created, refuses ? [] : ["dur"], "a refused creation is not the caller's, so a rollback cannot remove the winner's consumer");
        });
    });

    it("an unrelated failure of the lookup is not mistaken for a missing consumer", async () => {
        const connection = await connect({ servers });
        try {
            const jsm = await jetstreamManager(connection);
            const missingStream = uniqueName("nostream");
            const error = await ensureConsumer(jsm, missingStream, config(missingStream, 1_000_000_000), []).then(
                () => undefined,
                (e: unknown) => e,
            );
            assert.ok(error instanceof Error, "a missing stream is reported to the caller");
            assert.equal(isConsumerNotFound(error), false);
        } finally {
            await connection.close();
        }
    });
});

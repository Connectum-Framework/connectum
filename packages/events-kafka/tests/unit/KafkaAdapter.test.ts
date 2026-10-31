import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { Kafka } from "kafkajs";
import { defaultTopicDiscoveryIntervalMs, KafkaAdapter } from "../../src/KafkaAdapter.ts";

describe("KafkaAdapter", () => {
    it("throws when publishing without connection", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        await assert.rejects(
            () => adapter.publish("test.topic", new Uint8Array([1, 2, 3])),
            { message: "KafkaAdapter: not connected" },
        );
    });

    it("throws when subscribing without connection", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        await assert.rejects(
            () =>
                adapter.subscribe(["test.topic"], async () => {
                    // no-op handler
                }),
            { message: "KafkaAdapter: not connected" },
        );
    });

    it("accepts a redeliveryDelay up to the timer limit and rejects a negative, non-finite or larger one", () => {
        for (const good of [0, 250, 2_147_483_647]) {
            assert.doesNotThrow(() => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { redeliveryDelay: good } }));
        }

        for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
            assert.throws(
                () => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { redeliveryDelay: bad } }),
                { name: "RangeError", message: /redeliveryDelay must be a non-negative finite number/ },
            );
        }
    });

    it("accepts both commit strategies and rejects any other value", () => {
        for (const good of ["per-message", "per-batch"] as const) {
            assert.doesNotThrow(() => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { commitStrategy: good } }));
        }

        for (const bad of ["", "batch", "PER-BATCH", "per-message "]) {
            assert.throws(
                () => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { commitStrategy: bad as "per-batch" } }),
                { name: "RangeError", message: /commitStrategy must be "per-message" or "per-batch"/ },
            );
        }
    });

    it("accepts false or a positive topicDiscoveryInterval and rejects anything else", () => {
        for (const good of [false, 1, 2_147_483_647] as const) {
            assert.doesNotThrow(() => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { topicDiscoveryInterval: good } }));
        }

        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
            assert.throws(
                () => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { topicDiscoveryInterval: bad } }),
                { name: "RangeError", message: /topicDiscoveryInterval must be a positive finite number/ },
            );
        }
    });

    describe("topic matchers built from patterns", () => {
        /** Subscribe through the real adapter against a stubbed KafkaJS client and return what it handed to `consumer.subscribe`. */
        async function subscribedTopics(patterns: string[]): Promise<(string | RegExp)[]> {
            const proto = Kafka.prototype as unknown as Record<string, unknown>;
            const originalProducer = proto.producer;
            const originalConsumer = proto.consumer;
            const originalAdmin = proto.admin;
            let topics: (string | RegExp)[] = [];
            proto.producer = () => ({ connect: async () => undefined, disconnect: async () => undefined });
            proto.consumer = () => ({
                connect: async () => undefined,
                disconnect: async () => undefined,
                subscribe: async (request: { topics: (string | RegExp)[] }) => {
                    topics = request.topics;
                },
                run: async () => undefined,
                // A wildcard subscription listens for the crash that a deleted topic causes.
                events: { CRASH: "consumer.crash", GROUP_JOIN: "consumer.group_join" },
                on: () => () => undefined,
            });
            // A wildcard subscription lists the broker's topics once when it starts, whether or not discovery runs.
            proto.admin = () => ({ connect: async () => undefined, disconnect: async () => undefined, listTopics: async () => [] });
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { topicDiscoveryInterval: false } });
            try {
                await adapter.connect();
                const subscription = await adapter.subscribe(patterns, async () => undefined);
                await subscription.unsubscribe();
            } finally {
                proto.producer = originalProducer;
                proto.consumer = originalConsumer;
                proto.admin = originalAdmin;
                await adapter.disconnect();
            }
            return topics;
        }

        it("a pattern that opens with a wildcard does not match the broker's internal topics", async () => {
            const [all, star] = (await subscribedTopics([">", "*"])) as [RegExp, RegExp];
            for (const internal of ["__consumer_offsets", "__transaction_state"]) {
                assert.equal(all.test(internal), false, `> must not match ${internal}`);
                assert.equal(star.test(internal), false, `* must not match ${internal}`);
            }
            assert.equal(all.test("orders.created"), true);
            assert.equal(all.test("_schemas"), true, "a single leading underscore is an ordinary topic name");
            assert.equal(all.test("_a.b"), true);
            assert.equal(star.test("orders"), true);
        });

        it("a pattern that spells the double underscore out keeps matching such topics", async () => {
            const [wide, narrow] = (await subscribedTopics(["__audit.>", "__audit.*"])) as [RegExp, RegExp];
            assert.equal(wide.test("__audit.log"), true);
            assert.equal(wide.test("__audit.log.v2"), true);
            assert.equal(narrow.test("__audit.log"), true);
            assert.equal(narrow.test("__audit.log.v2"), false);
        });

        it("a pattern with a wildcard after the first segment is unchanged", async () => {
            const [star, tail] = (await subscribedTopics(["user.*", "user.>"])) as [RegExp, RegExp];
            assert.equal(star.test("user.created"), true);
            assert.equal(star.test("user.profile.updated"), false);
            assert.equal(tail.test("user.profile.updated"), true);
            assert.equal(tail.test("user"), false);
        });

        it("a pattern without wildcards stays a literal topic name, including an internal one", async () => {
            assert.deepEqual(await subscribedTopics(["user.created", "__consumer_offsets"]), ["user.created", "__consumer_offsets"]);
        });
    });

    describe("topicDiscoveryInterval default", () => {
        /**
         * Subscribe through the real adapter against a stubbed KafkaJS client and report how often the
         * adapter listed the broker's topics (once at the start of a wildcard subscription, to know
         * which topics it matched) and with which delays it scheduled a topic check (only discovery does).
         */
        async function topicChecks(patterns: string[], topicDiscoveryInterval?: number | false): Promise<{ listings: number; checkDelays: unknown[] }> {
            const proto = Kafka.prototype as unknown as Record<string, unknown>;
            const originalProducer = proto.producer;
            const originalConsumer = proto.consumer;
            const originalAdmin = proto.admin;
            const originalSetTimeout = globalThis.setTimeout;
            const checkDelays: unknown[] = [];
            let listings = 0;
            proto.producer = () => ({ connect: async () => undefined, disconnect: async () => undefined });
            proto.consumer = () => ({
                connect: async () => undefined,
                disconnect: async () => undefined,
                subscribe: async () => undefined,
                run: async () => undefined,
                stop: async () => undefined,
                events: { CRASH: "consumer.crash", GROUP_JOIN: "consumer.group_join" },
                on: () => () => undefined,
            });
            proto.admin = () => ({
                connect: async () => undefined,
                disconnect: async () => undefined,
                listTopics: async () => {
                    listings++;
                    return ["orders.created"];
                },
            });
            const adapter = KafkaAdapter({
                brokers: ["localhost:9092"],
                ...(topicDiscoveryInterval !== undefined && { consumerOptions: { topicDiscoveryInterval } }),
            });
            try {
                await adapter.connect();
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    checkDelays.push(args[1]);
                    return originalSetTimeout(...args);
                }) as typeof setTimeout;
                const subscription = await adapter.subscribe(patterns, async () => undefined);
                globalThis.setTimeout = originalSetTimeout;
                await subscription.unsubscribe();
            } finally {
                globalThis.setTimeout = originalSetTimeout;
                proto.producer = originalProducer;
                proto.consumer = originalConsumer;
                proto.admin = originalAdmin;
                await adapter.disconnect();
            }
            return { listings, checkDelays };
        }

        it("is five minutes, the metadata refresh period of the Kafka clients", () => {
            assert.equal(defaultTopicDiscoveryIntervalMs, 300_000);
        });

        it("runs discovery for a wildcard subscription when the option is not set: a check is scheduled every five minutes", async () => {
            assert.deepEqual(await topicChecks(["orders.*"]), { listings: 1, checkDelays: [300_000] });
        });

        it("does not run discovery when the option is false: the two start-up listings (before and after subscribing) are the only ones and no check is scheduled", async () => {
            assert.deepEqual(await topicChecks(["orders.*"], false), { listings: 2, checkDelays: [] });
        });

        it("takes the interval of the option for the scheduled check", async () => {
            assert.deepEqual(await topicChecks(["orders.*"], 45_000), { listings: 1, checkDelays: [45_000] });
        });

        it("never lists topics and never schedules a check for a subscription without wildcards", async () => {
            assert.deepEqual(await topicChecks(["orders.created"]), { listings: 0, checkDelays: [] });
        });
    });

    describe("recovery of a wildcard subscription that runs without topic discovery", () => {
        it("keeps a topic that was created between the first listing and the subscription when it replaces the consumer", async () => {
            const proto = Kafka.prototype as unknown as Record<string, unknown>;
            const originalProducer = proto.producer;
            const originalConsumer = proto.consumer;
            const originalAdmin = proto.admin;
            const originalWarn = console.warn;
            type Created = { config: { retry?: { restartOnFailure?: (error: Error) => Promise<boolean> } }; handlers: Record<string, (event: unknown) => void>; subscribed: unknown[] };
            const created: Created[] = [];
            let listings = 0;
            proto.producer = () => ({ connect: async () => undefined, disconnect: async () => undefined });
            proto.consumer = (config: Created["config"]) => {
                const record: Created = { config, handlers: {}, subscribed: [] };
                created.push(record);
                return {
                    connect: async () => undefined,
                    disconnect: async () => undefined,
                    subscribe: async (request: { topics: unknown[] }) => {
                        record.subscribed.push(request.topics);
                    },
                    run: async () => undefined,
                    stop: async () => undefined,
                    events: { CRASH: "consumer.crash", GROUP_JOIN: "consumer.group_join" },
                    on: (event: string, listener: (event: unknown) => void) => {
                        record.handlers[event] = listener;
                        return () => undefined;
                    },
                };
            };
            proto.admin = () => ({
                connect: async () => undefined,
                disconnect: async () => undefined,
                listTopics: async () => {
                    listings++;
                    // 1: before subscribe(); 2: after it, when orders.window already exists; later: orders.b has been deleted.
                    return listings === 1 ? ["orders.a", "orders.b"] : listings === 2 ? ["orders.a", "orders.b", "orders.window"] : ["orders.a", "orders.window"];
                },
            });
            console.warn = () => undefined;
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { topicDiscoveryInterval: false } });
            try {
                await adapter.connect();
                const subscription = await adapter.subscribe(["orders.*"], async () => undefined);
                const unknownTopic = Object.assign(new Error("This server does not host this topic-partition"), { type: "UNKNOWN_TOPIC_OR_PARTITION" });
                const restart = await created[0]?.config.retry?.restartOnFailure?.(unknownTopic);
                assert.equal(restart, false, "the deletion is confirmed, so the library is told not to restart the consumer");
                created[0]?.handlers["consumer.crash"]?.({ payload: { error: unknownTopic, groupId: "g", restart: false } });
                const start = Date.now();
                while (created[1]?.subscribed.length === undefined || created[1].subscribed.length === 0) {
                    if (Date.now() - start > 3_000) {
                        throw new Error("the replacement consumer was not started");
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert.deepEqual(created[1]?.subscribed[0], ["orders.a", "orders.window"], "the topic created in the window is still subscribed; only the deleted one is dropped");
                await subscription.unsubscribe();
            } finally {
                console.warn = originalWarn;
                proto.producer = originalProducer;
                proto.consumer = originalConsumer;
                proto.admin = originalAdmin;
                await adapter.disconnect();
            }
        });
    });

    describe("restartOnFailure of the application on a wildcard subscription", () => {
        /** What the `retry.restartOnFailure` a wildcard subscription gives its consumer answers for a plain network error, while the subscription is open. */
        async function answerFor(extra: Partial<Parameters<typeof KafkaAdapter>[0]>): Promise<boolean | undefined> {
            const proto = Kafka.prototype as unknown as Record<string, unknown>;
            const originalProducer = proto.producer;
            const originalConsumer = proto.consumer;
            const originalAdmin = proto.admin;
            let given: ((error: Error) => Promise<boolean>) | undefined;
            let answer: boolean | undefined;
            proto.producer = () => ({ connect: async () => undefined, disconnect: async () => undefined });
            proto.consumer = (config: { retry?: { restartOnFailure?: (error: Error) => Promise<boolean> } }) => {
                given = config.retry?.restartOnFailure;
                return {
                    connect: async () => undefined,
                    disconnect: async () => undefined,
                    subscribe: async () => undefined,
                    run: async () => undefined,
                    stop: async () => undefined,
                    events: { CRASH: "consumer.crash", GROUP_JOIN: "consumer.group_join" },
                    on: () => () => undefined,
                };
            };
            proto.admin = () => ({ connect: async () => undefined, disconnect: async () => undefined, listTopics: async () => ["orders.a"] });
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { topicDiscoveryInterval: false }, ...extra });
            try {
                await adapter.connect();
                const subscription = await adapter.subscribe(["orders.*"], async () => undefined);
                answer = await given?.(new Error("network"));
                await subscription.unsubscribe();
            } finally {
                proto.producer = originalProducer;
                proto.consumer = originalConsumer;
                proto.admin = originalAdmin;
                await adapter.disconnect();
            }
            return answer;
        }

        it("is asked for every crash the subscription does not take over", async () => {
            const asked: string[] = [];
            const policy = async (error: Error): Promise<boolean> => {
                asked.push(error.message);
                return false;
            };
            assert.equal(await answerFor({ clientOptions: { retry: { restartOnFailure: policy } } }), false, "the application's answer stands for a crash the subscription leaves to the library");
            assert.deepEqual(asked, ["network"]);
        });

        it("restarts a crash it does not take over when the application gave no policy", async () => {
            assert.equal(await answerFor({}), true);
        });
    });

    describe("redeliveryDelay default", () => {
        type EachBatch = (payload: unknown) => Promise<void>;

        /**
         * Subscribe through the real adapter against a stubbed KafkaJS client, hand the captured
         * `eachBatch` one message that the handler leaves unsettled, and report how many partition
         * pauses were requested and with which `setTimeout` delays.
         */
        async function unsettledMessage(redeliveryDelay?: number): Promise<{ pauses: number; delays: unknown[] }> {
            const proto = Kafka.prototype as unknown as Record<string, unknown>;
            const originalProducer = proto.producer;
            const originalConsumer = proto.consumer;
            const originalSetTimeout = globalThis.setTimeout;
            let eachBatch: EachBatch | undefined;
            proto.producer = () => ({ connect: async () => undefined, disconnect: async () => undefined });
            proto.consumer = () => ({
                connect: async () => undefined,
                disconnect: async () => undefined,
                subscribe: async () => undefined,
                run: async (config: { eachBatch: EachBatch }) => {
                    eachBatch = config.eachBatch;
                },
            });

            const delays: unknown[] = [];
            let pauses = 0;
            const adapter = KafkaAdapter({
                brokers: ["localhost:9092"],
                ...(redeliveryDelay !== undefined && { consumerOptions: { redeliveryDelay } }),
            });
            try {
                await adapter.connect();
                const subscription = await adapter.subscribe(["orders.created"], async () => undefined);
                assert.ok(eachBatch, "the adapter did not start the consumer");
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    delays.push(args[1]);
                    return originalSetTimeout(...args);
                }) as typeof setTimeout;
                await eachBatch({
                    batch: {
                        topic: "orders.created",
                        partition: 0,
                        messages: [{ offset: "0", key: null, value: Buffer.from("x"), timestamp: "1700000000000", headers: {}, attributes: 0 }],
                        lastOffset: () => "0",
                    },
                    resolveOffset: () => undefined,
                    commitOffsetsIfNecessary: async () => undefined,
                    heartbeat: async () => undefined,
                    isRunning: () => true,
                    isStale: () => false,
                    pause: () => {
                        pauses++;
                        return () => undefined;
                    },
                    uncommittedOffsets: () => ({ topics: [] }),
                });
                globalThis.setTimeout = originalSetTimeout;
                await subscription.unsubscribe();
            } finally {
                globalThis.setTimeout = originalSetTimeout;
                proto.producer = originalProducer;
                proto.consumer = originalConsumer;
                await adapter.disconnect();
            }
            return { pauses, delays };
        }

        it("pauses an unsettled message for 1000 ms when the option is not set", async () => {
            const { pauses, delays } = await unsettledMessage();
            assert.equal(pauses, 1);
            assert.deepEqual(delays, [1000]);
        });

        it("takes an explicit value over the default", async () => {
            const { pauses, delays } = await unsettledMessage(250);
            assert.equal(pauses, 1);
            assert.deepEqual(delays, [250]);
        });

        it("accepts 0 and then redelivers without pausing the partition", async () => {
            const { pauses, delays } = await unsettledMessage(0);
            assert.equal(pauses, 0);
            assert.deepEqual(delays, []);
        });
    });

    it("disconnect is safe to call without connect", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        // Should not throw
        await adapter.disconnect();
    });
});

/**
 * A stand-in for a Kafka broker that reads the client id from the header of the first request
 * (a request header is: int32 size, int16 api key, int16 api version, int32 correlation id,
 * then the client id as an int16-prefixed string) and drops the connection. `connect()` rejects,
 * and the identity the client announced is recorded. Nothing here needs a real broker.
 */
async function announcedClientId(run: (broker: string) => Promise<void>): Promise<string | null> {
    let clientId: string | null | undefined;
    const server = createServer((socket) => {
        socket.on("error", () => undefined);
        // TCP may deliver the header in pieces: collect bytes until the client id is complete.
        let received = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
            if (clientId !== undefined) {
                return;
            }
            received = Buffer.concat([received, chunk]);
            if (received.length < 14) {
                return;
            }
            const length = received.readInt16BE(12);
            if (length >= 0 && received.length < 14 + length) {
                return;
            }
            clientId = length < 0 ? null : received.toString("utf-8", 14, 14 + length);
            socket.destroy();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        await run(`127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.notEqual(clientId, undefined, "the client must have sent a request");
    return clientId as string | null;
}

describe("KafkaAdapter client id", () => {
    // The events guide: the EventBus derives a service identifier that adapters use as the broker
    // client identifier (Kafka `clientId`), and an explicit adapter option always wins. The
    // KafkaAdapterOptions reference: `clientId` defaults to "connectum".

    const unreachable = { retry: { retries: 0 }, connectionTimeout: 1_000 } as const;

    it("announces the service identifier given to connect() as the client id", async () => {
        const announced = await announcedClientId(async (broker) => {
            const adapter = KafkaAdapter({ brokers: [broker], ...unreachable });
            await assert.rejects(adapter.connect({ serviceName: "order.v1@test-host" }));
        });
        assert.equal(announced, "order.v1@test-host");
    });

    it("announces an explicit clientId instead of the service identifier", async () => {
        const announced = await announcedClientId(async (broker) => {
            const adapter = KafkaAdapter({ brokers: [broker], clientId: "explicit-client-id", ...unreachable });
            await assert.rejects(adapter.connect({ serviceName: "order.v1@test-host" }));
        });
        assert.equal(announced, "explicit-client-id");
    });

    it('announces "connectum" when there is neither an explicit client id nor a service identifier', async () => {
        const announced = await announcedClientId(async (broker) => {
            const adapter = KafkaAdapter({ brokers: [broker], ...unreachable });
            await assert.rejects(adapter.connect());
        });
        assert.equal(announced, "connectum");
    });
});

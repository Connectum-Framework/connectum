import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Kafka } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

describe("KafkaAdapter", () => {
    it("creates adapter with correct name", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        assert.equal(adapter.name, "kafka");
    });

    it("creates adapter with custom clientId", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            clientId: "my-service",
        });

        assert.equal(adapter.name, "kafka");
    });

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

    it("accepts multiple brokers", () => {
        const adapter = KafkaAdapter({
            brokers: ["broker1:9092", "broker2:9092", "broker3:9092"],
        });

        assert.equal(adapter.name, "kafka");
    });

    it("accepts producer options", () => {
        // CompressionTypes.GZIP = 1
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            producerOptions: {
                compression: 1,
            },
        });

        assert.equal(adapter.name, "kafka");
    });

    it("accepts consumer options", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            consumerOptions: {
                sessionTimeout: 60000,
                fromBeginning: true,
            },
        });

        assert.equal(adapter.name, "kafka");
    });

    it("accepts a redeliveryDelay up to the timer limit and rejects a negative, non-finite or larger one", () => {
        for (const good of [0, 250, 2_147_483_647]) {
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { redeliveryDelay: good } });
            assert.equal(adapter.name, "kafka");
        }

        for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
            assert.throws(
                () => KafkaAdapter({ brokers: ["localhost:9092"], consumerOptions: { redeliveryDelay: bad } }),
                { name: "RangeError", message: /redeliveryDelay must be a non-negative finite number/ },
            );
        }
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

    it("has all required EventAdapter methods", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        assert.equal(typeof adapter.connect, "function");
        assert.equal(typeof adapter.disconnect, "function");
        assert.equal(typeof adapter.publish, "function");
        assert.equal(typeof adapter.subscribe, "function");
        assert.equal(typeof adapter.name, "string");
    });

    it("disconnect is safe to call without connect", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        // Should not throw
        await adapter.disconnect();
    });
});

describe("KafkaAdapter internal utilities (indirect testing)", () => {
    // -----------------------------------------------------------------------
    // patternToKafkaTopicMatcher() — private function
    //
    // Maps NATS-style wildcard patterns to Kafka RegExp:
    //   - Literal pattern → returned as string
    //   - `*` → [^.]+ (single segment)
    //   - `>` → .+ (one or more segments)
    //   - Length > 256 → throws Error
    //
    // This function is called inside subscribe() which requires a connected
    // Kafka broker. We cannot test it directly in unit tests.
    //
    // However, we can verify the adapter's behavior with various pattern
    // inputs through the subscribe() error path (adapter must be connected).
    // Since subscribe() checks `if (!connected)` before calling
    // patternToKafkaTopicMatcher(), we can only test construction acceptance.
    //
    // For full coverage of this function, integration tests with a running
    // Kafka broker are required.
    // -----------------------------------------------------------------------

    it("should accept adapter construction with literal pattern-style topic names", () => {
        // patternToKafkaTopicMatcher("user.created") returns "user.created" (string)
        // This is tested indirectly via construction and subscribe error message
        const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });
        assert.ok(adapter);
    });

    it("should reject subscribe with literal pattern when not connected", async () => {
        const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

        // subscribe() fails before reaching patternToKafkaTopicMatcher
        await assert.rejects(
            () => adapter.subscribe(["user.created"], async () => {}),
            { message: "KafkaAdapter: not connected" },
        );
    });

    it("should reject subscribe with wildcard * pattern when not connected", async () => {
        const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

        // Pattern "user.*" would be converted to RegExp /^user\.[^.]+$/
        // but subscribe() fails before reaching patternToKafkaTopicMatcher
        await assert.rejects(
            () => adapter.subscribe(["user.*"], async () => {}),
            { message: "KafkaAdapter: not connected" },
        );
    });

    it("should reject subscribe with wildcard > pattern when not connected", async () => {
        const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

        // Pattern "events.>" would be converted to RegExp /^events\..+$/
        // but subscribe() fails before reaching patternToKafkaTopicMatcher
        await assert.rejects(
            () => adapter.subscribe(["events.>"], async () => {}),
            { message: "KafkaAdapter: not connected" },
        );
    });

    // NOTE: The 256-char limit check in patternToKafkaTopicMatcher() cannot be
    // tested without a connected adapter, because subscribe() checks connection
    // state before processing patterns. This would require an integration test.
    it("should reject subscribe with long pattern when not connected (pre-validation)", async () => {
        const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

        const longPattern = "a".repeat(300);
        // subscribe() rejects with "not connected" before the length check
        await assert.rejects(
            () => adapter.subscribe([longPattern], async () => {}),
            { message: "KafkaAdapter: not connected" },
        );
    });
});

describe("KafkaAdapter AdapterContext", () => {
    // Note: connect() calls `new Kafka(...)` then `kafka.producer().connect()`,
    // so we cannot test connect() success without a real broker. We verify the
    // connect() signature accepts the context parameter and that the clientId
    // fallback logic works indirectly through construction tests.

    it("connect() accepts AdapterContext parameter", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        // connect() should accept an optional AdapterContext
        assert.equal(typeof adapter.connect, "function");
    });

    it("connect() accepts AdapterContext without TypeError", async () => {
        // We cannot verify the actual Kafka clientId without a running broker,
        // but we can verify the adapter does not throw a TypeError when context is provided.
        // The actual clientId = options.clientId ?? context?.serviceName ?? "connectum"
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            kafkaConfig: { retry: { retries: 0 } },
        });

        // connect() will throw because no broker is available, but the error
        // should be a connection error, NOT a TypeError about the context parameter.
        await assert.rejects(
            () => adapter.connect({ serviceName: "order.v1@test-host" }),
            (err: Error) => {
                // Should fail with a connection-related error, not a type error
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for AdapterContext");
                return true;
            },
        );
    });

    it("adapter can be constructed with explicit clientId", () => {
        // Verify construction works with both clientId and context will be provided.
        // The priority chain is: options.clientId > context.serviceName > "connectum"
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            clientId: "explicit-client-id",
        });

        assert.equal(adapter.name, "kafka");
    });

    it("connect() works with undefined context (backward compat)", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            kafkaConfig: { retry: { retries: 0 } },
        });

        // Calling connect() without context should still work (minus broker availability)
        await assert.rejects(
            () => adapter.connect(),
            (err: Error) => {
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for missing context");
                return true;
            },
        );
    });
});

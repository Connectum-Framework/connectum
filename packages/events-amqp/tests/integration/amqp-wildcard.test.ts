/**
 * Wildcard-routing contract tests against the exact RabbitMQ patch used by
 * this regression. Set RUN_RECOVERY_TESTS=1 to enable the Testcontainers suite.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { StructSchema } from "@bufbuild/protobuf/wkt";
import { createEventBus, matchPattern } from "@connectum/events";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { RABBITMQ_IMAGE } from "./brokerImage.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";
const IMAGE = RABBITMQ_IMAGE;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(100);
    }
}

async function waitForAsync(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!(await cond())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitForAsync: condition not met in time");
        }
        await sleep(100);
    }
}

async function assertQueueMissing(container: StartedTestContainer, queueName: string): Promise<void> {
    const result = await container.exec(["rabbitmqctl", "list_queues", "name"]);
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output.split(/\r?\n/).map((name) => name.trim()).includes(queueName), false);
}

describe(`AMQP wildcard routing on ${IMAGE} (testcontainers)`, { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;

    before(async () => {
        container = await new GenericContainer(IMAGE).withExposedPorts(5672).start();
        url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
        const version = await container.exec(["rabbitmqctl", "version"]);
        assert.equal(version.exitCode, 0, version.output);
        assert.equal(version.output.trim(), "4.3.6", "the regression must execute against the pinned RabbitMQ patch");
    });

    after(async () => {
        await container?.stop();
    });

    it("terminal > excludes the base key for private, named-group, and topology-declared queues", async () => {
        for (const mode of ["private", "named", "topology"] as const) {
            const exchange = `it.wildcard.${mode}.${randomUUID()}`;
            const queue = `${exchange}.predeclared`;
            const adapter = AmqpAdapter({
                url,
                exchange,
                exchangeType: "topic",
                recovery: false,
                ...(mode === "topology"
                    ? {
                          topology: { queues: [{ name: queue, durable: true }] },
                          queueOverrides: { wildcard: { queue } },
                      }
                    : {}),
            });
            await adapter.connect();
            try {
                const received: string[] = [];
                const group = mode === "private" ? undefined : "wildcard";
                const subscription = await adapter.subscribe(
                    ["user.>"],
                    async (event, ack) => {
                        received.push(event.eventType);
                        await ack();
                    },
                    group ? { group } : undefined,
                );

                await adapter.publish("user", new Uint8Array([0]));
                await adapter.publish("user.created", new Uint8Array([1]));
                await adapter.publish("user.created.v2", new Uint8Array([2]));
                await adapter.publish("user.", new Uint8Array([3]));
                await adapter.publish("user..v2", new Uint8Array([4]));
                await waitFor(() => received.length >= 4);
                await sleep(250);

                assert.deepEqual(received, ["user.created", "user.created.v2", "user.", "user..v2"], `${mode} queue must exclude only the base routing key`);
                await subscription.unsubscribe();
            } finally {
                await adapter.disconnect();
            }
        }
    });

    it("characterizes RabbitMQ's literal wildcard characters and empty topic segments", async () => {
        const exchange = `it.wildcard-edges.${randomUUID()}`;
        const broker = await connect(url);
        const channel = await broker.createChannel();
        const hashQueue = `${exchange}.hash`;
        const hashWildcardQueue = `${exchange}.hash-wildcard`;
        const starHashQueue = `${exchange}.star-hash`;
        const literalQueue = `${exchange}.literal`;
        const keys = ["user", "user.created", "user.created.v2", "user.", "user..v2", "user.foo*", "user.foo>", "#"];
        try {
            await channel.assertExchange(exchange, "topic", { durable: false, autoDelete: true });
            await channel.assertQueue(hashQueue, { durable: false, exclusive: true, autoDelete: true });
            await channel.assertQueue(hashWildcardQueue, { durable: false, exclusive: true, autoDelete: true });
            await channel.assertQueue(starHashQueue, { durable: false, exclusive: true, autoDelete: true });
            await channel.assertQueue(literalQueue, { durable: false, exclusive: true, autoDelete: true });
            await channel.bindQueue(hashQueue, exchange, "user.#");
            await channel.bindQueue(hashWildcardQueue, exchange, "#");
            await channel.bindQueue(starHashQueue, exchange, "user.*.#");
            await channel.bindQueue(literalQueue, exchange, "user.foo*");
            await channel.bindQueue(literalQueue, exchange, "user.foo>");
            for (const key of keys) {
                channel.publish(exchange, key, Buffer.from(key));
            }

            await waitForAsync(async () => (await channel.checkQueue(hashQueue)).messageCount >= 7);

            const readKeys = async (queueName: string): Promise<string[]> => {
                const result: string[] = [];
                for (;;) {
                    const message = await channel.get(queueName, { noAck: true });
                    if (message === false) {
                        return result;
                    }
                    result.push(message.fields.routingKey);
                }
            };

            assert.deepEqual(await readKeys(hashQueue), keys.slice(0, -1));
            assert.deepEqual(await readKeys(hashWildcardQueue), keys);
            assert.deepEqual(await readKeys(starHashQueue), keys.slice(1, -1));
            assert.deepEqual(await readKeys(literalQueue), ["user.foo*", "user.foo>"]);
            assert.equal(matchPattern("#", "user"), false, "the common matcher treats # as literal content, unlike a RabbitMQ topic binding");
            assert.equal(matchPattern("#", "#"), true);
        } finally {
            await channel.close();
            await broker.close();
        }
    });

    it("rejects a complete # token on topic subscriptions before declaring their queue", async () => {
        const exchange = `it.wildcard-adapter-hash.${randomUUID()}`;
        const queue = `${exchange}.catchall`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        await adapter.connect();
        try {
            for (const pattern of ["#", "user.#"]) {
                await assert.rejects(
                    () => adapter.subscribe([pattern], async (_event, ack) => ack(), { group: "catchall" }),
                    (err: Error) => {
                        assert.ok(err instanceof TypeError);
                        assert.match(err.message, /RabbitMQ treats as a wildcard/);
                        return true;
                    },
                );
                await assertQueueMissing(container, queue);
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("allows # as a literal routing key on a direct exchange", async () => {
        const exchange = `it.wildcard-literal-hash.${randomUUID()}`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "direct", recovery: false });
        await adapter.connect();
        try {
            const received: string[] = [];
            const subscription = await adapter.subscribe(
                ["#"],
                async (event, ack) => {
                    received.push(event.eventType);
                    await ack();
                },
                { group: "literal-hash" },
            );
            await adapter.publish("user", new Uint8Array([1]));
            await adapter.publish("#", new Uint8Array([2]));
            await waitFor(() => received.length >= 1);
            await sleep(250);
            assert.deepEqual(received, ["#"]);
            assert.equal(matchPattern("#", "user"), false);
            assert.equal(matchPattern("#", "#"), true);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("preserves an operator-declared topic binding that uses #", async () => {
        const exchange = `it.wildcard-topology-hash.${randomUUID()}`;
        const queue = `${exchange}.operator`;
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: false,
            topology: {
                queues: [{ name: queue, durable: false, exclusive: true, autoDelete: true }],
                bindings: [{ source: exchange, queue, routingKey: "#" }],
            },
            queueOverrides: { operator: { queue } },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            const subscription = await adapter.subscribe(
                ["user.created"],
                async (event, ack) => {
                    received.push(event.eventType);
                    await ack();
                },
                { group: "operator" },
            );
            await adapter.publish("other.event", new Uint8Array([1]));
            await waitFor(() => received.length >= 1);
            assert.deepEqual(received, ["other.event"]);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("rejects complete wildcard segments on a direct exchange before queue declaration when the adapter binds", async () => {
        const exchange = `it.wildcard-reject.direct.${randomUUID()}`;
        const queue = `${exchange}.wildcard`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "direct", recovery: false });
        await adapter.connect();
        try {
            for (const pattern of ["user.*", "user.>"]) {
                await assert.rejects(
                    () => adapter.subscribe([pattern], async (_event, ack) => ack(), { group: "wildcard" }),
                    (err: Error) => {
                        assert.ok(err instanceof TypeError);
                        assert.match(err.message, /a direct exchange matches binding keys literally/);
                        return true;
                    },
                );

                await assertQueueMissing(container, queue);
            }

            const literal = await adapter.subscribe(["literal*", "literal>"], async (_event, ack) => ack(), { group: "literal" });
            await literal.unsubscribe();
            const literalHash = await adapter.subscribe(["#"], async (_event, ack) => ack(), { group: "hash" });
            await literalHash.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("accepts a wildcard on a direct exchange when the operator owns the bindings, and delivers what the operator bound", async () => {
        const exchange = `it.wildcard-direct-skip.${randomUUID()}`;
        const queue = `${exchange}.operator`;
        const conn = await connect(url);
        const channel = await conn.createChannel();
        await channel.assertExchange(exchange, "direct", { durable: true });
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, exchange, "user.created");
        await channel.bindQueue(queue, exchange, "user.deleted");
        await channel.close();
        await conn.close();

        const adapter = AmqpAdapter({ url, exchange, exchangeType: "direct", recovery: false, topologyMode: "skip", queueOverrides: { operator: { queue } } });
        await adapter.connect();
        try {
            const received: string[] = [];
            const subscription = await adapter.subscribe(
                ["user.*"],
                async (event, ack) => {
                    received.push(event.eventType);
                    await ack();
                },
                { group: "operator" },
            );
            await adapter.publish("user.created", new Uint8Array([1]));
            await adapter.publish("user.deleted", new Uint8Array([1]));
            await waitFor(() => received.length >= 2);
            await sleep(250);
            assert.deepEqual([...received].sort(), ["user.created", "user.deleted"]);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    for (const exchangeType of ["fanout", "headers"] as const) {
        it(`delivers every message to a ${exchangeType} queue whatever the subscription pattern`, async () => {
            const exchange = `it.wildcard-all.${exchangeType}.${randomUUID()}`;
            const adapter = AmqpAdapter({ url, exchange, exchangeType, recovery: false });
            await adapter.connect();
            try {
                const keys = ["user", "user.created", "user.created.eu", "order.created", "#"];
                const patterns: Array<{ pattern: string; group?: string }> = [{ pattern: "user.created", group: "literal" }, { pattern: "user.*", group: "single" }, { pattern: "user.>" }];
                const received = new Map<string, string[]>(patterns.map(({ pattern }) => [pattern, []]));
                for (const { pattern, group } of patterns) {
                    await adapter.subscribe(
                        [pattern],
                        async (event, ack) => {
                            received.get(pattern)?.push(event.eventType);
                            await ack();
                        },
                        group === undefined ? {} : { group },
                    );
                }
                for (const key of keys) {
                    await adapter.publish(key, new Uint8Array([1]));
                }
                await waitFor(() => [...received.values()].every((list) => list.length >= keys.length));
                await sleep(250);
                for (const [pattern, list] of received) {
                    assert.deepEqual([...list].sort(), [...keys].sort(), `${exchangeType} ${pattern}`);
                }
            } finally {
                await adapter.disconnect();
            }
        });
    }

    it("headers: the adapter's argument-less binding supersedes an operator's selective binding in assert mode", async () => {
        const exchange = `it.wildcard-headers-assert.${randomUUID()}`;
        const queue = `${exchange}.q`;
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "headers",
            recovery: false,
            topology: {
                queues: [{ name: queue, durable: true }],
                bindings: [{ queue, source: exchange, routingKey: "", arguments: { "x-match": "all", kind: "a" } }],
            },
            queueOverrides: { g: { queue } },
        });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["kind-a"],
                async (event, ack) => {
                    received.push(`${event.eventType}:${event.metadata.get("kind")}`);
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("kind-a", new Uint8Array([1]), { metadata: { kind: "a" } });
            await adapter.publish("kind-b", new Uint8Array([1]), { metadata: { kind: "b" } });
            await waitFor(() => received.length >= 2);
            assert.deepEqual([...received].sort(), ["kind-a:a", "kind-b:b"]);
        } finally {
            await adapter.disconnect();
        }
    });

    it("headers: with the operator owning the bindings (skip) a selective binding filters", async () => {
        const exchange = `it.wildcard-headers-skip.${randomUUID()}`;
        const queue = `${exchange}.q`;
        const conn = await connect(url);
        const channel = await conn.createChannel();
        await channel.assertExchange(exchange, "headers", { durable: true });
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, exchange, "", { "x-match": "all", kind: "a" });
        await channel.close();
        await conn.close();

        const adapter = AmqpAdapter({ url, exchange, exchangeType: "headers", recovery: false, topologyMode: "skip", queueOverrides: { g: { queue } } });
        await adapter.connect();
        try {
            const received: string[] = [];
            await adapter.subscribe(
                ["kind-a"],
                async (event, ack) => {
                    received.push(`${event.eventType}:${event.metadata.get("kind")}`);
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("kind-a", new Uint8Array([1]), { metadata: { kind: "a" } });
            await adapter.publish("kind-b", new Uint8Array([1]), { metadata: { kind: "b" } });
            await waitFor(() => received.length >= 1);
            await sleep(250);
            assert.deepEqual(received, ["kind-a:a"]);
        } finally {
            await adapter.disconnect();
        }
    });

    it("fanout: the EventBus dispatches only matching handlers on routes and acknowledges the rest", async () => {
        const exchange = `it.wildcard-bus-fanout.${randomUUID()}`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "fanout", recovery: false });
        const handled: string[] = [];
        const route = (localName: string, topic: string) => ({
            localName,
            // The topic is the proto input type name when no (event).topic option is set.
            input: Object.create(StructSchema, { typeName: { value: topic, writable: false, enumerable: true } }),
            proto: { options: undefined },
        });
        const service = {
            typeName: "it.v1.UserService",
            methods: [route("created", "user.created"), route("anyOrder", "order.*")],
        };
        const bus = createEventBus({
            adapter,
            group: "bus",
            routes: [
                (router) => {
                    router.service(service as never, {
                        created: async (_msg: unknown, ctx: { eventType: string }) => void handled.push(ctx.eventType),
                        anyOrder: async (_msg: unknown, ctx: { eventType: string }) => void handled.push(ctx.eventType),
                    } as never);
                },
            ],
        });
        await bus.start();
        const probe = await connect(url);
        const channel = await probe.createChannel();
        try {
            const keys = ["user.created", "order.paid", "audit.logged", "user.deleted"];
            for (const key of keys) {
                await adapter.publish(key, new Uint8Array());
            }
            await waitFor(() => handled.length >= 2);
            await sleep(500);
            assert.deepEqual([...handled].sort(), ["order.paid", "user.created"]);
            // Stopping closes the consumer channel, which requeues anything left
            // unacknowledged: an empty queue afterwards proves the messages the
            // bus had no handler for were acknowledged, not parked.
            await bus.stop();
            const queue = `${exchange}.bus`;
            await waitForAsync(async () => (await channel.checkQueue(queue)).messageCount === 0);
        } finally {
            await channel.close();
            await probe.close();
            await bus.stop();
        }
    });

    it("rejects a non-terminal complete > segment before queue declaration", async () => {
        const exchange = `it.wildcard-invalid-position.${randomUUID()}`;
        const queue = `${exchange}.invalid`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        await adapter.connect();
        try {
            await assert.rejects(
                () => adapter.subscribe(["user.>.created"], async (_event, ack) => ack(), { group: "invalid" }),
                (err: Error) => {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /outside the terminal segment/);
                    return true;
                },
            );

            await assertQueueMissing(container, queue);
        } finally {
            await adapter.disconnect();
        }
    });

    it("keeps old broad queue bindings until explicitly migrated", async () => {
        const exchange = `it.wildcard-existing.${randomUUID()}`;
        const queue = `${exchange}.workers`;
        const broker = await connect(url);
        const channel = await broker.createChannel();
        await channel.assertExchange(exchange, "topic", { durable: true });
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, exchange, "user.#");

        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: false,
            topology: { queues: [{ name: queue, durable: true }] },
            queueOverrides: { workers: { queue } },
        });
        try {
            await adapter.connect();
            const received: string[] = [];
            const subscription = await adapter.subscribe(
                ["user.>"],
                async (event, ack) => {
                    received.push(event.eventType);
                    await ack();
                },
                { group: "workers" },
            );

            await adapter.publish("user", new Uint8Array([0]));
            await waitFor(() => received.length === 1);
            assert.deepEqual(received, ["user"], "the operator-owned legacy binding still routes the base key");
            await subscription.unsubscribe();

            channel.publish(exchange, "user", Buffer.from("still routed by the old binding"));
            await waitForAsync(async () => (await channel.checkQueue(queue)).messageCount === 1);
            const retained = await channel.get(queue, { noAck: true });
            assert.ok(retained);
            assert.equal(retained.fields.routingKey, "user");
        } finally {
            await adapter.disconnect();
            await channel.close();
            await broker.close();
        }
    });

    it("removes only the obsolete binding while retaining queued messages and the durable queue", async () => {
        const exchange = `it.wildcard-migration.${randomUUID()}`;
        const queue = `${exchange}.workers`;
        const broker = await connect(url);
        const channel = await broker.createChannel();
        try {
            await channel.assertExchange(exchange, "topic", { durable: true });
            await channel.assertQueue(queue, { durable: true });
            await channel.bindQueue(queue, exchange, "user.#");
            channel.publish(exchange, "user.created", Buffer.from("queued before migration"), { persistent: true });
            await waitForAsync(async () => (await channel.checkQueue(queue)).messageCount === 1);

            await channel.bindQueue(queue, exchange, "user.*.#");
            await channel.unbindQueue(queue, exchange, "user.#");
            assert.equal((await channel.checkQueue(queue)).messageCount, 1);

            channel.publish(exchange, "user", Buffer.from("base key after migration"));
            await sleep(250);
            assert.equal((await channel.checkQueue(queue)).messageCount, 1, "the base key must not route after the old binding is removed");
            const retained = await channel.get(queue, { noAck: true });
            assert.ok(retained);
            assert.equal(retained.content.toString(), "queued before migration");
            assert.equal(await channel.get(queue, { noAck: true }), false);
        } finally {
            await channel.close();
            await broker.close();
        }
    });

    it("replays the corrected terminal wildcard binding after consumer recovery", { timeout: 60_000 }, async () => {
        const exchange = `it.wildcard-recovery.${randomUUID()}`;
        const lifecycle: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
                onDisconnected: () => lifecycle.push("disconnected"),
            },
        });
        const received: string[] = [];
        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(
                ["user.>"],
                async (event, ack) => {
                    received.push(event.eventType);
                    await ack();
                },
                { group: "workers" },
            );
            await adapter.publish("user.created", new Uint8Array([1]));
            await waitFor(() => received.length === 1);

            const dropped = await container.exec(["rabbitmqctl", "close_all_connections", "wildcard-recovery"]);
            assert.equal(dropped.exitCode, 0, dropped.output);
            await waitFor(() => lifecycle.filter((event) => event === "connected").length >= 2);
            await adapter.publish("user", new Uint8Array([0]));
            await adapter.publish("user.created.v2", new Uint8Array([2]));
            await waitFor(() => received.length >= 2);
            await sleep(250);

            assert.deepEqual(received, ["user.created", "user.created.v2"]);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("re-binds an auto-named exclusive queue with the corrected terminal wildcard after the connection is lost", { timeout: 60_000 }, async () => {
        const exchange = `it.wildcard-recovery-auto.${randomUUID()}`;
        const lifecycle: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: {
                onConnected: () => lifecycle.push("connected"),
            },
        });
        const received: string[] = [];
        await adapter.connect();
        try {
            // No group: the queue is exclusive and auto-delete, so the broker removes it
            // together with its bindings when the connection drops. Routing after recovery
            // therefore proves the adapter bound a fresh queue with the translated pattern.
            const subscription = await adapter.subscribe(["user.>"], async (event, ack) => {
                received.push(event.eventType);
                await ack();
            });
            await adapter.publish("user.created", new Uint8Array([1]));
            await waitFor(() => received.length === 1);

            const dropped = await container.exec(["rabbitmqctl", "close_all_connections", "wildcard-recovery-auto"]);
            assert.equal(dropped.exitCode, 0, dropped.output);
            await waitFor(() => lifecycle.filter((event) => event === "connected").length >= 2);
            await adapter.publish("user", new Uint8Array([0]));
            await adapter.publish("user.created.v2", new Uint8Array([2]));
            await waitFor(() => received.length >= 2);
            await sleep(250);

            assert.deepEqual(received, ["user.created", "user.created.v2"]);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });
});

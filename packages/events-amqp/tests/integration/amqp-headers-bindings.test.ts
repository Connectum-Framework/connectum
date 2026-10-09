/**
 * Headers-exchange binding ownership against the exact RabbitMQ patch used by
 * the wildcard-routing regression. A headers exchange delivers a message when
 * ANY binding of the queue matches, so the adapter's own argument-less binding
 * would defeat a selective binding the topology declares for the same queue.
 * Set RUN_RECOVERY_TESTS=1 to enable the Testcontainers suite.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { connect } from "amqplib";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import type { AmqpAdapterOptions } from "../../src/types.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";
const IMAGE = "rabbitmq:4.3.6-alpine";

const SELECTIVE = { "x-match": "all", kind: "a" } as const;

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

/** One row of `rabbitmqctl list_bindings --formatter json`; the argument table is a list of `[name, type, value]` triples. */
interface ListedBinding {
    readonly source_name: string;
    readonly destination_name: string;
    readonly destination_kind: string;
    readonly routing_key: string;
    readonly arguments: ReadonlyArray<readonly [string, string, unknown]>;
}

interface BrokerBinding {
    readonly routingKey: string;
    readonly arguments: Record<string, unknown>;
}

describe(`AMQP headers exchange bindings on ${IMAGE} (testcontainers)`, { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
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

    /** The bindings the broker really holds for `queue`, read with the broker's own tool rather than inferred from delivery. */
    async function bindingsOf(exchange: string, queue: string): Promise<BrokerBinding[]> {
        const listed = await container.exec(["rabbitmqctl", "-q", "list_bindings", "source_name", "destination_name", "destination_kind", "routing_key", "arguments", "--formatter", "json"]);
        assert.equal(listed.exitCode, 0, listed.output);
        const all = JSON.parse(listed.output) as ListedBinding[];
        return all
            .filter((b) => b.source_name === exchange && b.destination_name === queue && b.destination_kind === "queue")
            .map((b) => ({ routingKey: b.routing_key, arguments: Object.fromEntries(b.arguments.map(([name, , value]) => [name, value])) }));
    }

    /** Pre-create the exchange and queue and bind them outside the adapter, the way an operator's tooling would. */
    async function operatorBind(exchange: string, queue: string): Promise<void> {
        const conn = await connect(url);
        const channel = await conn.createChannel();
        await channel.assertExchange(exchange, "headers", { durable: true });
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, exchange, "", { ...SELECTIVE });
        await channel.close();
        await conn.close();
    }

    /** Subscribe `kind-a`, publish kind-a/a, kind-b/b and kind-a/b, and report what the handler saw. */
    async function observe(exchange: string, queue: string, extra: Partial<AmqpAdapterOptions>): Promise<string[]> {
        const seen: string[] = [];
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "headers", recovery: false, queueOverrides: { g: { queue } }, ...extra });
        await adapter.connect();
        try {
            await adapter.subscribe(
                ["kind-a"],
                async (event, ack) => {
                    seen.push(`${event.eventType}:${event.metadata.get("kind")}`);
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("kind-a", new Uint8Array([1]), { metadata: { kind: "a" } });
            await adapter.publish("kind-b", new Uint8Array([1]), { metadata: { kind: "b" } });
            await adapter.publish("kind-a", new Uint8Array([1]), { metadata: { kind: "b" } });
            await sleep(800);
        } finally {
            await adapter.disconnect();
        }
        return seen.sort();
    }

    it("a queue without declared bindings receives every message through the adapter's argument-less binding", async () => {
        const exchange = `it.headers-catchall.${randomUUID()}`;
        const queue = `${exchange}.q`;
        const seen = await observe(exchange, queue, { topology: { queues: [{ name: queue, durable: true }] } });

        assert.deepEqual(seen, ["kind-a:a", "kind-a:b", "kind-b:b"]);
        const bindings = await bindingsOf(exchange, queue);
        assert.equal(bindings.length, 1, "exactly the adapter's own binding exists");
        assert.deepEqual(bindings[0]?.arguments, {}, "the adapter's binding carries no arguments");
    });

    it("a binding declared in the topology is the subscription's binding and filters", async () => {
        const exchange = `it.headers-declared.${randomUUID()}`;
        const queue = `${exchange}.q`;
        const seen = await observe(exchange, queue, {
            topology: { queues: [{ name: queue, durable: true }], bindings: [{ queue, source: exchange, routingKey: "", arguments: { ...SELECTIVE } }] },
        });

        assert.deepEqual(seen, ["kind-a:a"]);
        const bindings = await bindingsOf(exchange, queue);
        assert.equal(bindings.length, 1, "the adapter added no binding of its own");
        assert.deepEqual(bindings[0]?.arguments, SELECTIVE);
    });

    it("a binding declared without arguments keeps the catch-all (the migration path)", async () => {
        const exchange = `it.headers-declared-open.${randomUUID()}`;
        const queue = `${exchange}.q`;
        const seen = await observe(exchange, queue, {
            topology: { queues: [{ name: queue, durable: true }], bindings: [{ queue, source: exchange, routingKey: "" }] },
        });

        assert.deepEqual(seen, ["kind-a:a", "kind-a:b", "kind-b:b"]);
    });

    it("a binding declared for another queue does not make the topology the owner of this queue's bindings", async () => {
        const exchange = `it.headers-other-queue.${randomUUID()}`;
        const queue = `${exchange}.q`;
        const other = `${exchange}.other`;
        const seen = await observe(exchange, queue, {
            topology: {
                queues: [
                    { name: queue, durable: true },
                    { name: other, durable: true },
                ],
                bindings: [{ queue: other, source: exchange, routingKey: "", arguments: { ...SELECTIVE } }],
            },
        });

        assert.deepEqual(seen, ["kind-a:a", "kind-a:b", "kind-b:b"]);
        const bindings = await bindingsOf(exchange, queue);
        assert.equal(bindings.length, 1, "the adapter bound this queue itself");
    });

    it("a selective binding created outside the topology is not seen: the adapter still adds its catch-all", async () => {
        const exchange = `it.headers-outside.${randomUUID()}`;
        const queue = `${exchange}.q`;
        await operatorBind(exchange, queue);
        const seen = await observe(exchange, queue, { topology: { queues: [{ name: queue, durable: true }] } });

        assert.deepEqual(seen, ["kind-a:a", "kind-a:b", "kind-b:b"]);
    });

    it("check mode leaves the operator's selective binding alone and it filters", async () => {
        const exchange = `it.headers-check.${randomUUID()}`;
        const queue = `${exchange}.q`;
        await operatorBind(exchange, queue);
        const seen = await observe(exchange, queue, { topologyMode: "check" });

        assert.deepEqual(seen, ["kind-a:a"]);
        assert.equal((await bindingsOf(exchange, queue)).length, 1);
    });

    it("selectivity and the single declared binding survive a lost connection", { timeout: 60_000 }, async () => {
        const exchange = `it.headers-recovery.${randomUUID()}`;
        const queue = `${exchange}.q`;
        let connected = 0;
        const received: string[] = [];
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "headers",
            recovery: { initialDelay: 100, maxDelay: 500 },
            lifecycle: { onConnected: () => connected++ },
            topology: { queues: [{ name: queue, durable: true }], bindings: [{ queue, source: exchange, routingKey: "", arguments: { ...SELECTIVE } }] },
            queueOverrides: { g: { queue } },
        });
        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(
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

            const dropped = await container.exec(["rabbitmqctl", "close_all_connections", "headers-recovery"]);
            assert.equal(dropped.exitCode, 0, dropped.output);
            await waitFor(() => connected >= 2);
            await adapter.publish("kind-b", new Uint8Array([1]), { metadata: { kind: "b" } });
            await adapter.publish("kind-a", new Uint8Array([1]), { metadata: { kind: "a" } });
            await waitFor(() => received.length >= 2);
            await sleep(500);

            assert.deepEqual(received, ["kind-a:a", "kind-a:a"]);
            const bindings = await bindingsOf(exchange, queue);
            assert.equal(bindings.length, 1, "recovery neither duplicated the declared binding nor added a catch-all");
            assert.deepEqual(bindings[0]?.arguments, SELECTIVE);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });
});

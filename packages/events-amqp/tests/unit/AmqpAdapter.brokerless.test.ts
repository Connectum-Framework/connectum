/**
 * Behaviour of the real `AmqpAdapter` that needs a connection object but no
 * broker: the adapter is driven through a hand-written `ChannelModel` that
 * answers every operation and refuses exactly one chosen declaration.
 *
 * The adapter loads `amqplib` through a dynamic `import()`. The CommonJS
 * module's `connect` is replaced here before the first such import happens, so
 * the substitute is what the adapter calls. This file therefore must not share
 * a process with a test that needs the real `connect`.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import type { AmqpAdapterOptions, AmqpTopologyObject } from "../../src/index.ts";
import { AmqpAdapter, AmqpTopologyError, AmqpTopologyMode } from "../../src/index.ts";
import { FakeAmqpAdapter } from "../../src/testing.ts";

interface Refusal {
    /** Channel method that fails. */
    readonly method: string;
    /** When set, only a call whose first argument equals this value fails. */
    readonly firstArg?: string;
}

interface Call {
    readonly method: string;
    readonly args: unknown[];
}

interface Published {
    readonly routingKey: string;
    readonly headers: Record<string, unknown>;
}

/** A broker reply as amqplib reports it: an error carrying the reply code. */
function brokerReply(code: number, text: string): Error {
    return Object.assign(new Error(text), { code });
}

function makeChannel(refusal: Refusal | null, reply: Error, calls: Call[], published: Published[]): EventEmitter {
    const channel = new EventEmitter();
    const op =
        (method: string, result: unknown = {}) =>
        async (...args: unknown[]): Promise<unknown> => {
            calls.push({ method, args });
            if (refusal !== null && refusal.method === method && (refusal.firstArg === undefined || args[0] === refusal.firstArg)) {
                throw reply;
            }
            return result;
        };
    Object.assign(channel, {
        assertExchange: op("assertExchange"),
        checkExchange: op("checkExchange"),
        assertQueue: op("assertQueue"),
        checkQueue: op("checkQueue"),
        bindQueue: op("bindQueue"),
        bindExchange: op("bindExchange"),
        prefetch: op("prefetch"),
        consume: op("consume", { consumerTag: "tag-1" }),
        cancel: op("cancel"),
        deleteQueue: op("deleteQueue"),
        close: op("close"),
        publish: (_exchange: string, routingKey: string, _body: Buffer, props: { headers: Record<string, unknown> }, confirm: (err: Error | null) => void): boolean => {
            published.push({ routingKey, headers: { ...props.headers } });
            confirm(null);
            return true;
        },
    });
    return channel;
}

function makeModel(refusal: Refusal | null, reply: Error = brokerReply(404, "NOT_FOUND")) {
    const calls: Call[] = [];
    const published: Published[] = [];
    const model = new EventEmitter();
    Object.assign(model, {
        createConfirmChannel: async () => makeChannel(refusal, reply, calls, published),
        createChannel: async () => makeChannel(refusal, reply, calls, published),
        close: async () => undefined,
    });
    return { model, calls, published };
}

const amqplibModule = createRequire(import.meta.url)("amqplib") as { connect: (...args: unknown[]) => Promise<unknown> };
const realConnect = amqplibModule.connect;
let activeModel: unknown = null;
amqplibModule.connect = async () => activeModel;

after(() => {
    amqplibModule.connect = realConnect;
});

const EXCHANGE = "orders";
const GROUP = "workers";
const GROUP_QUEUE = `${EXCHANGE}.${GROUP}`;

function adapterFor(overrides: Partial<AmqpAdapterOptions>) {
    return AmqpAdapter({ url: "amqp://fake.invalid", exchange: EXCHANGE, recovery: false, ...overrides });
}

async function connectFailureObject(overrides: Partial<AmqpAdapterOptions>, refusal: Refusal): Promise<AmqpTopologyObject | undefined> {
    activeModel = makeModel(refusal).model;
    const adapter = adapterFor(overrides);
    try {
        await adapter.connect();
    } catch (err) {
        assert.ok(err instanceof AmqpTopologyError, `expected AmqpTopologyError, got ${String(err)}`);
        return err.object;
    } finally {
        await adapter.disconnect();
    }
    throw new assert.AssertionError({ message: "connect() was expected to reject" });
}

/** The `object` of the `AmqpTopologyError` that `subscribe()` rejects with, after a clean `connect()`. */
async function subscribeFailureObject(overrides: Partial<AmqpAdapterOptions>, refusal: Refusal): Promise<AmqpTopologyObject | undefined> {
    activeModel = makeModel(refusal).model;
    const adapter = adapterFor(overrides);
    try {
        await adapter.connect();
        await adapter.subscribe(["order.created"], async () => undefined, { group: GROUP });
    } catch (err) {
        assert.ok(err instanceof AmqpTopologyError, `expected AmqpTopologyError, got ${String(err)}`);
        return err.object;
    } finally {
        await adapter.disconnect();
    }
    throw new assert.AssertionError({ message: "subscribe() was expected to reject" });
}

describe("AmqpTopologyError.object at every declaration site", () => {
    // Shape of the identity: `{ kind: 'exchange' | 'queue', name }`, or for a
    // binding `{ kind: 'binding', source, destination, destinationType,
    // routingKey }` — the documented machine-readable contract.
    describe("assert mode, applied at connect()", () => {
        it("the main exchange refused: kind 'exchange' with the configured exchange name", async () => {
            assert.deepEqual(await connectFailureObject({}, { method: "assertExchange" }), { kind: "exchange", name: EXCHANGE });
        });

        it("a topology exchange refused: kind 'exchange' with that exchange's name", async () => {
            const object = await connectFailureObject({ topology: { exchanges: [{ name: "orders.dlx", type: "fanout" }] } }, { method: "assertExchange", firstArg: "orders.dlx" });
            assert.deepEqual(object, { kind: "exchange", name: "orders.dlx" });
        });

        it("a topology queue refused: kind 'queue' with that queue's name", async () => {
            const object = await connectFailureObject({ topology: { queues: [{ name: "billing.q" }] } }, { method: "assertQueue" });
            assert.deepEqual(object, { kind: "queue", name: "billing.q" });
        });

        it("a binding to a queue refused: kind 'binding' with both endpoints, destinationType 'queue' and the routing key", async () => {
            const object = await connectFailureObject({ topology: { bindings: [{ source: EXCHANGE, queue: "billing.q", routingKey: "invoice.*" }] } }, { method: "bindQueue" });
            assert.deepEqual(object, { kind: "binding", source: EXCHANGE, destination: "billing.q", destinationType: "queue", routingKey: "invoice.*" });
        });

        it("a binding to an exchange refused: kind 'binding' with destinationType 'exchange'", async () => {
            const object = await connectFailureObject({ topology: { bindings: [{ source: EXCHANGE, exchange: "orders.audit", routingKey: "#" }] } }, { method: "bindExchange" });
            assert.deepEqual(object, { kind: "binding", source: EXCHANGE, destination: "orders.audit", destinationType: "exchange", routingKey: "#" });
        });
    });

    describe("check mode, applied at connect()", () => {
        it("the main exchange missing: kind 'exchange'", async () => {
            const object = await connectFailureObject({ topologyMode: AmqpTopologyMode.CHECK }, { method: "checkExchange" });
            assert.deepEqual(object, { kind: "exchange", name: EXCHANGE });
        });

        it("a topology exchange missing: kind 'exchange' with that exchange's name", async () => {
            const object = await connectFailureObject(
                { topologyMode: AmqpTopologyMode.CHECK, topology: { exchanges: [{ name: "orders.dlx", type: "fanout" }] } },
                { method: "checkExchange", firstArg: "orders.dlx" },
            );
            assert.deepEqual(object, { kind: "exchange", name: "orders.dlx" });
        });

        it("a topology queue missing: kind 'queue'", async () => {
            const object = await connectFailureObject({ topologyMode: AmqpTopologyMode.CHECK, topology: { queues: [{ name: "billing.q" }] } }, { method: "checkQueue" });
            assert.deepEqual(object, { kind: "queue", name: "billing.q" });
        });
    });

    describe("subscribe()", () => {
        it("check mode: the group's queue missing names that queue", async () => {
            const object = await subscribeFailureObject({ topologyMode: AmqpTopologyMode.CHECK }, { method: "checkQueue" });
            assert.deepEqual(object, { kind: "queue", name: GROUP_QUEUE });
        });

        it("assert mode: the group's queue refused names that queue", async () => {
            const object = await subscribeFailureObject({}, { method: "assertQueue" });
            assert.deepEqual(object, { kind: "queue", name: GROUP_QUEUE });
        });

        it("assert mode: the subscription's own binding refused names the binding", async () => {
            const object = await subscribeFailureObject({}, { method: "bindQueue" });
            assert.deepEqual(object, { kind: "binding", source: EXCHANGE, destination: GROUP_QUEUE, destinationType: "queue", routingKey: "order.created" });
        });

        it("a queue declared in the topology: binding the subscription to it refused names the binding", async () => {
            const object = await subscribeFailureObject({ topology: { queues: [{ name: GROUP_QUEUE }] } }, { method: "bindQueue" });
            assert.deepEqual(object, { kind: "binding", source: EXCHANGE, destination: GROUP_QUEUE, destinationType: "queue", routingKey: "order.created" });
        });

        it("consume refused (the queue vanished): kind 'queue' with the consumed queue", async () => {
            const object = await subscribeFailureObject({ topologyMode: AmqpTopologyMode.SKIP }, { method: "consume" });
            assert.deepEqual(object, { kind: "queue", name: GROUP_QUEUE });
        });
    });
});

describe("envelope headers: real adapter and fake agree", () => {
    // Documented: the publish envelope uses `x-event-id` and `x-published-at`,
    // and `x-connectum-publish-id` correlates a mandatory publish; delivery
    // strips all three from the handler-visible metadata.
    const ENVELOPE_HEADERS = ["x-connectum-publish-id", "x-event-id", "x-published-at"];

    it("the real adapter stamps exactly the documented envelope on top of the caller's headers", async () => {
        const { model, published } = makeModel(null);
        activeModel = model;
        const adapter = adapterFor({ publisherOptions: { mandatory: true } });
        try {
            await adapter.connect();
            await adapter.publish("order.created", new Uint8Array([1]), { metadata: { custom: "v" } });
        } finally {
            await adapter.disconnect();
        }
        assert.equal(published.length, 1);
        assert.deepEqual(Object.keys(published[0]?.headers ?? {}).sort(), ["custom", ...ENVELOPE_HEADERS]);
    });

    it("an external contract drops the adapter's own envelope keys from the caller's metadata and sends the rest as given", async () => {
        // Documented: in external-contract mode the wire frame carries only the headers the caller
        // supplied, and the adapter's own envelope keys are dropped from them too.
        const { model, published } = makeModel(null);
        activeModel = model;
        const adapter = adapterFor({ publisherOptions: { externalContract: true } });
        try {
            await adapter.connect();
            await adapter.publish("order.created", new Uint8Array([1]), {
                metadata: { "x-trace-id": "t1", "x-event-id": "spoofed", "x-published-at": "spoofed", "x-connectum-publish-id": "spoofed" },
            });
        } finally {
            await adapter.disconnect();
        }
        assert.equal(published.length, 1);
        assert.deepEqual(published[0]?.headers, { "x-trace-id": "t1" });
    });

    it("the fake strips the same documented envelope from the metadata a handler sees", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        const seen: string[][] = [];
        await fake.subscribe(["order.created"], async (event) => {
            seen.push([...event.metadata.keys()].sort());
        });

        const metadata: Record<string, string> = { custom: "v" };
        for (const header of ENVELOPE_HEADERS) {
            metadata[header] = header === "x-published-at" ? "2026-01-02T03:04:05.000Z" : "envelope-value";
        }
        await fake.control.deliver("order.created", new Uint8Array([1]), { metadata });

        assert.deepEqual(seen, [["custom"]]);
    });
});

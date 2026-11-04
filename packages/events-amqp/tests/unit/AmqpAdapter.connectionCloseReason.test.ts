/**
 * When the broker answers a declaration with a connection exception, amqplib
 * reports the reason on the connection (`error`, then `close`) and rejects the
 * pending channel operation with the generic "Channel ended, no reply will be
 * forthcoming". The adapter must keep the broker's reason in the error it
 * throws, or the operator is left with a message that explains nothing.
 *
 * The adapter is driven through a hand-written connection, as in the other
 * brokerless tests; see AmqpAdapter.brokerless.test.ts for why the amqplib
 * `connect` is replaced and why this file needs its own process.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { withConnectionCloseReason } from "../../src/AmqpAdapter.ts";
import { AmqpAdapter, AmqpTopologyError } from "../../src/index.ts";

/** What RabbitMQ 4.3 answers to a non-durable queue with a name: a connection exception. */
const BROKER_REASON = Object.assign(new Error('Connection closed: 541 (INTERNAL-ERROR) with message "INTERNAL_ERROR - Feature `transient_nonexcl_queues` is deprecated."'), { code: 541 });
const CHANNEL_ENDED = new Error("Channel ended, no reply will be forthcoming");

interface FakeModel extends EventEmitter {
    createConfirmChannel(): Promise<EventEmitter>;
    createChannel(): Promise<EventEmitter>;
    close(): Promise<void>;
}

/**
 * A connection whose `assertQueue` makes the broker close the connection: the
 * reason is emitted first, then the pending operation is rejected, which is the
 * order amqplib uses.
 */
function modelRefusingQueueDeclare(emitted: "error" | "close" | "nothing"): FakeModel {
    const channel = (): EventEmitter => {
        const ch = new EventEmitter();
        Object.assign(ch, {
            assertExchange: async () => ({}),
            assertQueue: async () => {
                if (emitted === "error") {
                    model.emit("error", BROKER_REASON);
                    model.emit("close", BROKER_REASON);
                } else if (emitted === "close") {
                    model.emit("close", BROKER_REASON);
                }
                throw CHANNEL_ENDED;
            },
            prefetch: async () => ({}),
            bindQueue: async () => ({}),
            consume: async () => ({ consumerTag: "tag" }),
            cancel: async () => ({}),
            deleteQueue: async () => ({}),
            close: async () => undefined,
            publish: (_exchange: string, _key: string, _body: Buffer, _props: unknown, confirm: (err: Error | null) => void): boolean => {
                confirm(null);
                return true;
            },
        });
        return ch;
    };
    const model = new EventEmitter() as FakeModel;
    Object.assign(model, { createConfirmChannel: async () => channel(), createChannel: async () => channel(), close: async () => undefined });
    return model;
}

const amqplibModule = createRequire(import.meta.url)("amqplib") as { connect: (...args: unknown[]) => Promise<unknown> };
const realConnect = amqplibModule.connect;
let activeModel: unknown = null;
amqplibModule.connect = async () => activeModel;
after(() => {
    amqplibModule.connect = realConnect;
});

/** The error `subscribe()` rejects with, and how many listeners the connection gained (or lost) while it ran. */
async function declareFailure(model: FakeModel): Promise<{ error: unknown; listenerDelta: number }> {
    activeModel = model;
    const adapter = AmqpAdapter({ url: "amqp://fake.invalid", exchange: "orders", recovery: false, queueOptions: { durable: false } });
    await adapter.connect();
    const listeners = (): number => model.listenerCount("error") + model.listenerCount("close");
    const before = listeners();
    try {
        const error = await adapter.subscribe(["order.created"], async () => undefined, { group: "workers" }).then(
            () => null,
            (e: unknown) => e,
        );
        return { error, listenerDelta: listeners() - before };
    } finally {
        await adapter.disconnect();
    }
}

describe("subscribe() when the broker closes the connection during the queue declaration", () => {
    for (const emitted of ["error", "close"] as const) {
        it(`the error carries the broker's reason, reported by the connection '${emitted}' event`, async () => {
            const model = modelRefusingQueueDeclare(emitted);
            const { error, listenerDelta } = await declareFailure(model);

            assert.ok(error instanceof AmqpTopologyError, `expected AmqpTopologyError, got ${String(error)}`);
            assert.match(error.message, /Failed to declare queue 'orders\.workers'/);
            assert.match(error.message, /541/);
            assert.match(error.message, /transient_nonexcl_queues/);
            assert.equal(error.cause, BROKER_REASON, "the cause is the broker's close reason, with its reply code");
            assert.deepEqual(error.object, { kind: "queue", name: "orders.workers" });
            assert.equal(listenerDelta, 0, "the listeners that capture the reason are removed once subscribe() has failed");
        });
    }

    it("a refusal without a connection reason is reported as before", async () => {
        const { error } = await declareFailure(modelRefusingQueueDeclare("nothing"));

        assert.ok(error instanceof AmqpTopologyError);
        assert.equal(error.message, "Failed to declare queue 'orders.workers': Channel ended, no reply will be forthcoming");
        assert.equal(error.cause, CHANNEL_ENDED);
    });
});

describe("withConnectionCloseReason", () => {
    const reason = Object.assign(new Error("Connection closed: 541 (INTERNAL-ERROR)"), { code: 541 });

    it("keeps a topology error whose cause is already a broker reply with its own code", () => {
        const reply = Object.assign(new Error("PRECONDITION_FAILED - inequivalent arg"), { code: 406 });
        const error = new AmqpTopologyError("Failed to declare queue 'q': PRECONDITION_FAILED - inequivalent arg", { cause: reply });
        assert.equal(withConnectionCloseReason(error, reason), error);
    });

    it("passes through everything it is not meant for", () => {
        const ended = new AmqpTopologyError("Failed to declare queue 'q': Channel ended, no reply will be forthcoming", { cause: CHANNEL_ENDED });
        assert.equal(withConnectionCloseReason(ended, undefined), ended, "no reason recorded");
        const plain = new Error("something else");
        assert.equal(withConnectionCloseReason(plain, reason), plain, "not a topology error");
        const noCause = new AmqpTopologyError("Binding for source 'x' must declare either 'queue' or 'exchange'");
        assert.equal(withConnectionCloseReason(noCause, reason), noCause, "no underlying failure to replace");
    });

    it("keeps the failing object and the message prefix when it replaces the generic failure", () => {
        const ended = new AmqpTopologyError("Failed to declare queue 'q': Channel ended, no reply will be forthcoming", { cause: CHANNEL_ENDED, object: { kind: "queue", name: "q" } });
        const replaced = withConnectionCloseReason(ended, reason);
        assert.ok(replaced instanceof AmqpTopologyError);
        assert.equal(replaced.message, "Failed to declare queue 'q': Connection closed: 541 (INTERNAL-ERROR)");
        assert.deepEqual(replaced.object, { kind: "queue", name: "q" });
        assert.equal(replaced.cause, reason);
    });
});

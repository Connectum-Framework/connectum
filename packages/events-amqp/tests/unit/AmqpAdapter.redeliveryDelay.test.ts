/**
 * `consumerOptions.redeliveryDelay` (opt-in) pauses between the moment a
 * handler fails and the moment the message is requeued, so a handler that keeps
 * throwing is not redelivered as fast as the broker can send it. Without the
 * option the message is requeued at once, as before.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type amqp from "amqplib";
import { handleDelivery } from "../../src/AmqpAdapter.ts";
import { AmqpAdapter, type AmqpAdapterOptions, type AmqpLifecycleEvent } from "../../src/index.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeMessage(): amqp.ConsumeMessage {
    return {
        content: Buffer.from("payload"),
        fields: { deliveryTag: 7, redelivered: false, exchange: "ex", routingKey: "orders.created", consumerTag: "ctag" },
        properties: { headers: {}, messageId: "m1" },
    } as unknown as amqp.ConsumeMessage;
}

/** A channel that records what the delivery does with the message and can be closed like amqplib's. */
function makeChannel() {
    const calls: Array<{ readonly call: string; readonly at: number }> = [];
    const start = Date.now();
    let closed = false;
    const channel = Object.assign(new EventEmitter(), {
        ack: () => {
            calls.push({ call: "ack", at: Date.now() - start });
        },
        nack: (_message: amqp.Message, _allUpTo: boolean, requeue: boolean) => {
            if (closed) {
                throw Object.assign(new Error("Channel closed"), { name: "IllegalOperationError" });
            }
            calls.push({ call: requeue ? "nack-requeue" : "nack-reject", at: Date.now() - start });
        },
        close: () => {
            closed = true;
            channel.emit("close");
        },
    });
    return { channel, calls };
}

const failing = async (): Promise<void> => {
    throw new Error("handler failed");
};

describe("redeliveryDelay on a failed handler", () => {
    it("holds the message for the delay and then requeues it", { timeout: 10_000 }, async () => {
        const { channel, calls } = makeChannel();
        const done = handleDelivery({ channel, message: makeMessage(), queue: "q", handler: failing, decode: undefined, lifecycle: undefined, redeliveryDelay: 150 });

        await sleep(40);
        assert.equal(calls.length, 0, "the message must not be requeued before the delay has passed");

        await done;
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.call, "nack-requeue");
        assert.ok((calls[0]?.at ?? 0) >= 120, `requeued after ${calls[0]?.at} ms, expected about 150`);
    });

    it("without the option the message is requeued at once", async () => {
        const { channel, calls } = makeChannel();
        await handleDelivery({ channel, message: makeMessage(), queue: "q", handler: failing, decode: undefined, lifecycle: undefined });
        assert.deepEqual(
            calls.map((c) => c.call),
            ["nack-requeue"],
        );
        assert.ok((calls[0]?.at ?? Number.POSITIVE_INFINITY) < 100);
    });

    it("a delay of 0 is the same as no delay", async () => {
        const { channel, calls } = makeChannel();
        await handleDelivery({ channel, message: makeMessage(), queue: "q", handler: failing, decode: undefined, lifecycle: undefined, redeliveryDelay: 0 });
        assert.deepEqual(
            calls.map((c) => c.call),
            ["nack-requeue"],
        );
    });

    it("a handler that already settled the delivery is not delayed and not requeued again", async () => {
        const { channel, calls } = makeChannel();
        const startedAt = Date.now();
        await handleDelivery({
            channel,
            message: makeMessage(),
            queue: "q",
            handler: async (_event, ack) => {
                await ack();
                throw new Error("failed after ack");
            },
            decode: undefined,
            lifecycle: undefined,
            redeliveryDelay: 5_000,
        });
        assert.deepEqual(
            calls.map((c) => c.call),
            ["ack"],
        );
        assert.ok(Date.now() - startedAt < 1_000, "the delay applies only to a message the handler left unsettled");
    });

    it("a channel that closes during the delay ends the wait at once and reports the skipped requeue", async () => {
        const { channel, calls } = makeChannel();
        const events: AmqpLifecycleEvent[] = [];
        const startedAt = Date.now();
        const done = handleDelivery({
            channel,
            message: makeMessage(),
            queue: "q",
            handler: failing,
            decode: undefined,
            lifecycle: { onLifecycle: (event) => events.push(event) },
            redeliveryDelay: 5_000,
        });
        await sleep(30);
        channel.close();
        await done;

        assert.ok(Date.now() - startedAt < 1_000, "closing the channel must not leave the delivery waiting for the timer");
        assert.equal(calls.length, 0, "nothing was applied to the closed channel");
        assert.deepEqual(
            events.map((event) => (event.type === "settlement-skipped" ? `${event.type}:${event.action}` : event.type)),
            ["settlement-skipped:requeue"],
        );
        assert.equal(channel.listenerCount("close"), 0, "the wait leaves no listener behind");
    });
});

describe("consumerOptions.redeliveryDelay validation", () => {
    const create = (redeliveryDelay: unknown): void => {
        AmqpAdapter({ url: "amqp://127.0.0.1:1", consumerOptions: { redeliveryDelay } } as unknown as AmqpAdapterOptions);
    };

    it("accepts 0, a fraction and the largest timer delay", () => {
        for (const value of [0, 250, 0.5, 2_147_483_647, undefined]) {
            assert.doesNotThrow(() => create(value), String(value));
        }
    });

    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        it(`rejects ${bad} with a RangeError that names the option`, () => {
            assert.throws(
                () => create(bad),
                (error: unknown) => error instanceof RangeError && error.message.includes("consumerOptions.redeliveryDelay"),
            );
        });
    }

    it("rejects a non-number with a TypeError", () => {
        assert.throws(
            () => create("1000"),
            (error: unknown) => error instanceof TypeError && error.message.includes("consumerOptions.redeliveryDelay"),
        );
    });
});

/**
 * Two properties of `EventBus.stop()`:
 *
 * - two `stop()` calls made while `start()` is still running share one shutdown, so the adapter is
 *   disconnected once (both used to wait for the start, then each began its own shutdown);
 * - the gate error of `publish()` says whether the bus is stopping or was never started, because
 *   the remedy differs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventSubscription } from "../../src/types.ts";

const eventMsg = () => create(EventOptionsSchema, {});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An adapter whose connect() settles only when the test says so, and which counts disconnect(). */
function makeAdapter() {
    let finishConnect: () => void = () => undefined;
    const counts = { connect: 0, disconnect: 0 };
    const adapter: EventAdapter = {
        name: "stop-guard",
        connect: () =>
            new Promise<void>((resolve) => {
                counts.connect++;
                finishConnect = resolve;
            }),
        disconnect: async () => {
            counts.disconnect++;
        },
        publish: async () => undefined,
        subscribe: async (): Promise<EventSubscription> => ({ unsubscribe: async () => undefined }),
    };
    return { adapter, counts, finishConnect: () => finishConnect() };
}

describe("EventBus.stop() called more than once while start() runs", () => {
    it("shares one shutdown: the adapter is disconnected once and both calls settle", async () => {
        const { adapter, counts, finishConnect } = makeAdapter();
        const bus = createEventBus({ adapter });

        const starting = bus.start();
        await sleep(10); // start() is now inside adapter.connect()
        const first = bus.stop();
        const second = bus.stop();

        finishConnect();
        await starting;
        await Promise.all([first, second]);

        assert.equal(counts.disconnect, 1, "two stop() calls during start() must disconnect the adapter once");
    });

    it("a stop() after the shutdown has finished is a no-op", async () => {
        const { adapter, counts, finishConnect } = makeAdapter();
        const bus = createEventBus({ adapter });

        const starting = bus.start();
        await sleep(10);
        finishConnect();
        await starting;
        await bus.stop();
        await bus.stop();

        assert.equal(counts.disconnect, 1);
    });
});

describe("the gate error of publish()", () => {
    it('says the bus is stopping while it drains, not that it was never started', async () => {
        const { adapter, finishConnect } = makeAdapter();
        let releaseUnsubscribe: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
            releaseUnsubscribe = resolve;
        });
        adapter.subscribe = async (): Promise<EventSubscription> => ({ unsubscribe: () => holding });
        const bus = createEventBus({
            adapter,
            routes: [
                (router) => {
                    // one route, so that the bus has a subscription whose unsubscribe holds stop() open
                    router.service({ typeName: "t.v1.S", methods: [{ localName: "m", input: { typeName: EventOptionsSchema.typeName }, proto: { options: undefined } }] } as never, { m: async () => undefined } as never);
                },
            ],
        });
        const starting = bus.start();
        await sleep(10);
        finishConnect();
        await starting;

        const stopping = bus.stop();
        await assert.rejects(
            () => bus.publish(EventOptionsSchema, eventMsg()),
            (error: unknown) => error instanceof Error && error.message === "EventBus is stopping: it accepts no new events while it drains. Wait for stop() to finish, then call start() again to publish.",
        );
        releaseUnsubscribe();
        await stopping;
    });

    it("says the bus was never started when it was not", async () => {
        const { adapter } = makeAdapter();
        const bus = createEventBus({ adapter });

        await assert.rejects(
            () => bus.publish(EventOptionsSchema, eventMsg()),
            (error: unknown) => error instanceof Error && error.message === "EventBus not started. Call start() first.",
        );
    });

    it("says the bus was never started after a completed shutdown too", async () => {
        const { adapter, finishConnect } = makeAdapter();
        const bus = createEventBus({ adapter });
        const starting = bus.start();
        await sleep(10);
        finishConnect();
        await starting;
        await bus.stop();

        await assert.rejects(
            () => bus.publish(EventOptionsSchema, eventMsg()),
            (error: unknown) => error instanceof Error && error.message === "EventBus not started. Call start() first.",
        );
    });
});

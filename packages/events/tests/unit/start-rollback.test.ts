/**
 * When `start()` fails it rolls back (unsubscribes, disconnects the adapter) and rethrows. A
 * disconnect that fails during that rollback must not replace the error that caused the failure:
 * the caller needs the cause, and the bus is left in a state where `start()` can be tried again.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter } from "../../src/types.ts";

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.RollbackService", methods: [fakeMethod] } as any;

const route = (router: { service: (descriptor: unknown, handlers: unknown) => void }) => {
    router.service(fakeService, { simpleEvent: async () => undefined });
};

function makeAdapter(overrides: Partial<EventAdapter>): { adapter: EventAdapter; disconnects: () => number } {
    let disconnects = 0;
    const adapter: EventAdapter = {
        name: "rollback",
        connect: async () => undefined,
        disconnect: async () => {
            disconnects += 1;
        },
        publish: async () => undefined,
        subscribe: async () => ({ unsubscribe: async () => undefined }),
        ...overrides,
    };
    return { adapter, disconnects: () => disconnects };
}

describe("start() rollback", () => {
    it("rejects with the connect error when disconnect() also fails", async () => {
        const original = new Error("ORIGINAL: connection refused");
        let disconnectAttempts = 0;
        const { adapter } = makeAdapter({
            connect: async () => {
                throw original;
            },
            disconnect: async () => {
                disconnectAttempts += 1;
                throw new Error("disconnect-secondary");
            },
        });
        // biome-ignore lint/suspicious/noExplicitAny: route against a fake descriptor
        const bus = createEventBus({ adapter, routes: [route as any] });

        await assert.rejects(
            () => bus.start(),
            (error: unknown) => error === original,
        );
        assert.equal(disconnectAttempts, 1, "the rollback still tried to disconnect, once");
    });

    it("rejects with the subscribe error when disconnect() also fails", async () => {
        const original = new Error("ORIGINAL: subscribe refused");
        const { adapter } = makeAdapter({
            subscribe: async () => {
                throw original;
            },
            disconnect: async () => {
                throw new Error("disconnect-secondary");
            },
        });
        // biome-ignore lint/suspicious/noExplicitAny: route against a fake descriptor
        const bus = createEventBus({ adapter, routes: [route as any] });

        await assert.rejects(
            () => bus.start(),
            (error: unknown) => error === original,
        );
    });

    it("still disconnects once and rejects with the cause when disconnect() succeeds", async () => {
        const original = new Error("ORIGINAL: connection refused");
        const { adapter, disconnects } = makeAdapter({
            connect: async () => {
                throw original;
            },
        });
        const bus = createEventBus({ adapter });

        await assert.rejects(
            () => bus.start(),
            (error: unknown) => error === original,
        );
        assert.equal(disconnects(), 1);
    });

    it("leaves the bus startable again after a failed rollback", async () => {
        let attempt = 0;
        const { adapter } = makeAdapter({
            connect: async () => {
                attempt += 1;
                if (attempt === 1) {
                    throw new Error("ORIGINAL: connection refused");
                }
            },
            disconnect: async () => {
                throw new Error("disconnect-secondary");
            },
        });
        const bus = createEventBus({ adapter });

        await assert.rejects(() => bus.start(), /ORIGINAL/);
        await bus.start();
    });
});

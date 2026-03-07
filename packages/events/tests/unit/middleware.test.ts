import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import { composeMiddleware } from "../../src/middleware.ts";
import type { EventMiddleware, RawEvent } from "../../src/types.ts";

function makeRawEvent(): RawEvent {
    return {
        eventId: "test-1",
        eventType: "test.event",
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
    };
}

function makeCtx() {
    return createEventContext({
        raw: makeRawEvent(),
        signal: AbortSignal.timeout(1000),
        onAck: async () => {},
        onNack: async () => {},
    });
}

describe("composeMiddleware", () => {
    it("calls handler directly with no middleware", async () => {
        let called = false;
        const handler = composeMiddleware([], async () => {
            called = true;
        });
        await handler(makeRawEvent(), makeCtx());
        assert.equal(called, true);
    });

    it("middleware wraps handler in onion order", async () => {
        const order: string[] = [];
        const mw1: EventMiddleware = async (_e, _c, next) => {
            order.push("mw1-before");
            await next();
            order.push("mw1-after");
        };
        const mw2: EventMiddleware = async (_e, _c, next) => {
            order.push("mw2-before");
            await next();
            order.push("mw2-after");
        };

        const handler = composeMiddleware([mw1, mw2], async () => {
            order.push("handler");
        });

        await handler(makeRawEvent(), makeCtx());
        assert.deepEqual(order, ["mw1-before", "mw2-before", "handler", "mw2-after", "mw1-after"]);
    });

    it("middleware can short-circuit by not calling next", async () => {
        let handlerCalled = false;
        const mw: EventMiddleware = async () => {
            // Don't call next
        };

        const handler = composeMiddleware([mw], async () => {
            handlerCalled = true;
        });

        await handler(makeRawEvent(), makeCtx());
        assert.equal(handlerCalled, false);
    });

    it("throws when next() is called multiple times", async () => {
        const badMiddleware: EventMiddleware = async (_e, _c, next) => {
            await next();
            await next(); // Should throw
        };

        const handler = composeMiddleware([badMiddleware], async () => {});
        await assert.rejects(() => handler(makeRawEvent(), makeCtx()), {
            message: /next\(\) called multiple times/,
        });
    });

    it("error in handler propagates through middleware", async () => {
        const mw: EventMiddleware = async (_e, _c, next) => {
            await next();
        };

        const handler = composeMiddleware([mw], async () => {
            throw new Error("handler error");
        });

        await assert.rejects(() => handler(makeRawEvent(), makeCtx()), {
            message: /handler error/,
        });
    });

    it("middleware error propagates without swallowing", async () => {
        const mw: EventMiddleware = async (_e, _c, _next) => {
            throw new Error("middleware error");
        };

        const handler = composeMiddleware([mw], async () => {});
        await assert.rejects(() => handler(makeRawEvent(), makeCtx()), {
            message: /middleware error/,
        });
    });
});

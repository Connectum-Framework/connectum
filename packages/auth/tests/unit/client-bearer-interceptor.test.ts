/**
 * Unit tests for the client-side Bearer token interceptor
 *
 * Tests createClientBearerInterceptor() for static tokens,
 * async token factories, and header overwrite behavior.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { createClientBearerInterceptor } from "../../src/client-bearer-interceptor.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

describe("client-bearer-interceptor", () => {
    describe("createClientBearerInterceptor()", () => {
        it("should set Authorization header with static token", async () => {
            const interceptor = createClientBearerInterceptor({ token: "my-static-token" });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            assert.strictEqual(req.header.get("authorization"), "Bearer my-static-token");
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should call async token factory and set Authorization header", async () => {
            const tokenFactory = mock.fn(async () => "async-refreshed-token");

            const interceptor = createClientBearerInterceptor({ token: tokenFactory as () => Promise<string> });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            assert.strictEqual(tokenFactory.mock.calls.length, 1);
            assert.strictEqual(req.header.get("authorization"), "Bearer async-refreshed-token");
            assert.strictEqual(next.mock.calls.length, 1);
        });

        // Guide: the factory "is called before every request", so a token that expires and is
        // refreshed between two calls must reach the second request, not be remembered from the first.
        it("should call the token factory before every request and send the fresh token each time", async () => {
            let issued = 0;
            const tokenFactory = mock.fn(async () => `token-${++issued}`);
            const next = createMockNext();
            const handler = createClientBearerInterceptor({ token: tokenFactory })(next);

            const first = createMockRequest(MOCK_REQUEST_DEFAULTS);
            const second = createMockRequest(MOCK_REQUEST_DEFAULTS);
            const third = createMockRequest(MOCK_REQUEST_DEFAULTS);
            await handler(first);
            await handler(second);
            await handler(third);

            assert.strictEqual(tokenFactory.mock.calls.length, 3);
            assert.strictEqual(first.header.get("authorization"), "Bearer token-1");
            assert.strictEqual(second.header.get("authorization"), "Bearer token-2");
            assert.strictEqual(third.header.get("authorization"), "Bearer token-3");
        });

        it("should wait for the token factory before sending the request", async () => {
            let release: (token: string) => void = () => undefined;
            const pending = new Promise<string>((resolve) => {
                release = resolve;
            });
            const next = createMockNext();
            const handler = createClientBearerInterceptor({ token: () => pending })(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            const call = handler(req);
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(next.mock.calls.length, 0, "the request must not be sent before the token is known");

            release("late-token");
            await call;
            assert.strictEqual(next.mock.calls.length, 1);
            assert.strictEqual(req.header.get("authorization"), "Bearer late-token");
        });

        it("should overwrite existing Authorization header", async () => {
            const interceptor = createClientBearerInterceptor({ token: "new-token" });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer old-token");

            await handler(req);

            assert.strictEqual(req.header.get("authorization"), "Bearer new-token");
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });
});

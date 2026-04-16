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

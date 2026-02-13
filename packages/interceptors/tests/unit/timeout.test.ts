/**
 * Timeout interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

describe("timeout interceptor", () => {
    it("should pass request within timeout", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 1000 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => ({ message: { result: "success" } }));

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should reject request after timeout", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 100 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            // Simulate slow service
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { message: { result: "success" } };
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.DeadlineExceeded);
                return true;
            },
        );

        // Wait for mock timer to drain
        await new Promise((resolve) => setTimeout(resolve, 250));
    });

    it("should include timeout duration in error", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 50 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { message: "success" };
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert((err as ConnectError).message.includes("50ms"));
                return true;
            },
        );

        // Wait for mock timer to drain
        await new Promise((resolve) => setTimeout(resolve, 150));
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 100, skipStreaming: true });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: true, // Streaming request
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => ({ message: { result: "streaming" } }));

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "streaming");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should handle custom duration", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 200 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return { message: { result: "success" } };
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.DeadlineExceeded);
                assert((err as ConnectError).message.includes("200ms"));
                return true;
            },
        );

        // Wait for mock timer to drain
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it("should cleanup on timeout", async () => {
        let cleanedUp = false;
        const interceptor = createTimeoutInterceptor({ duration: 50 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            try {
                await new Promise((resolve) => setTimeout(resolve, 100));
                return { message: "success" };
            } finally {
                cleanedUp = true;
            }
        });

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        // Wait a bit for cleanup
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.strictEqual(cleanedUp, true);
    });

    it("should not timeout fast requests", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 1000 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            // Fast request
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { message: { result: "fast" } };
        });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "fast");
    });

    it("should reject invalid duration", () => {
        assert.throws(() => createTimeoutInterceptor({ duration: 0 }), /duration must be a positive finite number/);
        assert.throws(() => createTimeoutInterceptor({ duration: -1 }), /duration must be a positive finite number/);
        assert.throws(() => createTimeoutInterceptor({ duration: Number.POSITIVE_INFINITY }), /duration must be a positive finite number/);
    });

    it("should use default duration", async () => {
        const interceptor = createTimeoutInterceptor(); // Uses default 30000ms

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => ({ message: { result: "success" } }));

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
    });
});

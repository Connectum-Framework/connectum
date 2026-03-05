/**
 * Timeout interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextSlow, createMockRequest } from "@connectum/testing";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

describe("timeout interceptor", () => {
    it("should pass request within timeout", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 1000 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should reject request after timeout", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 100 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextSlow(200);

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.DeadlineExceeded);
                return true;
            },
        );

        // Wait for mock timer to drain
        await new Promise((resolve) => setTimeout(resolve, 250));
    });

    it("should include timeout duration in error", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 50 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextSlow(100);

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.DeadlineExceeded, "50ms");
                return true;
            },
        );

        // Wait for mock timer to drain
        await new Promise((resolve) => setTimeout(resolve, 150));
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 100, skipStreaming: true });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });

        const next = createMockNext({ message: { result: "streaming" } });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "streaming");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should handle custom duration", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 200 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextSlow(300);

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.DeadlineExceeded, "200ms");
                return true;
            },
        );

        // Wait for mock timer to drain
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it("should cleanup on timeout", async () => {
        let cleanedUp = false;
        const interceptor = createTimeoutInterceptor({ duration: 50 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

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

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextSlow(10, { message: { result: "fast" } });

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

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
    });
});

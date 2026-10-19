/**
 * Timeout interceptor tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextSlow, createMockRequest } from "@connectum/test-fixtures";
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

        // The downstream call outlives the 100 ms limit: a streaming call is passed through
        // without a deadline, so the response still arrives instead of DeadlineExceeded.
        const next = createMockNextSlow(250, { message: { result: "streaming" } });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "streaming");
        assert.strictEqual(next.mock.calls.length, 1);
        // The request is handed on as is: no cancellation signal is derived for it.
        assert.strictEqual(next.mock.calls[0].arguments[0], mockReq);
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

    it("should not timeout fast requests", async () => {
        const interceptor = createTimeoutInterceptor({ duration: 1000 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextSlow(10, { message: { result: "fast" } });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "fast");
    });

    for (const [label, duration, got] of [
        ["zero", 0, "0"],
        ["negative", -1, "-1"],
        ["infinite", Number.POSITIVE_INFINITY, "Infinity"],
        ["NaN", Number.NaN, "NaN"],
        ["fractional", 0.5, "0.5"],
        // One above the platform timer ceiling: the timer would fire after 1 ms instead of waiting.
        ["above the timer ceiling", 2_147_483_648, "2147483648"],
    ] as const) {
        it(`should refuse a ${label} duration with a RangeError naming the factory, the rule and the value`, () => {
            assert.throws(
                () => createTimeoutInterceptor({ duration }),
                (err: unknown) =>
                    err instanceof RangeError && err.message === `createTimeoutInterceptor: duration must be an integer from 1 to 2147483647 milliseconds, got ${got}`,
            );
        });
    }

    it("should refuse a non-number duration with a TypeError", () => {
        assert.throws(
            () => createTimeoutInterceptor({ duration: "30s" as unknown as number }),
            (err: unknown) => err instanceof TypeError && err.message === 'createTimeoutInterceptor: duration must be an integer from 1 to 2147483647 milliseconds, got "30s"',
        );
    });

    it("should accept the boundary durations 1 and 2147483647", () => {
        assert.strictEqual(typeof createTimeoutInterceptor({ duration: 1 }), "function");
        assert.strictEqual(typeof createTimeoutInterceptor({ duration: 2_147_483_647 }), "function");
    });

    it("should use default duration", async () => {
        const interceptor = createTimeoutInterceptor(); // Uses default 30000ms

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
    });

    describe("streaming with skipStreaming option", () => {
        it("should apply timeout to streaming request when skipStreaming=false", async () => {
            const interceptor = createTimeoutInterceptor({ duration: 100, skipStreaming: false });

            const mockReq = createMockRequest({
                service: "test.Service",
                method: "StreamMethod",
                message: { field: "value" },
                stream: true,
            });

            const next = createMockNextSlow(200);

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.DeadlineExceeded, "100ms");
                    return true;
                },
            );

            // Wait for mock timer to drain
            await new Promise((resolve) => setTimeout(resolve, 250));
        });

        it("should pass through streaming request when skipStreaming=true (default)", async () => {
            const interceptor = createTimeoutInterceptor({ duration: 50, skipStreaming: true });

            const mockReq = createMockRequest({
                service: "test.Service",
                method: "StreamMethod",
                message: { field: "value" },
                stream: true,
            });

            const next = createMockNextSlow(100, { message: { result: "streamed" } });

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual((result.message as any).result, "streamed");
        });
    });
});

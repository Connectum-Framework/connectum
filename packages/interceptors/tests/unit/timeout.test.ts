/**
 * Timeout interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
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

    for (const [label, duration, got] of [
        ["zero", 0, "0"],
        ["negative", -1, "-1"],
        ["infinite", Number.POSITIVE_INFINITY, "Infinity"],
        ["NaN", Number.NaN, "NaN"],
        ["fractional below the minimum", 0.5, "0.5"],
        // A fraction inside the range: only the integer rule can refuse it.
        ["fractional inside the range", 1.5, "1.5"],
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

    // The default limit is 30000 ms: a call that never answers is still open one
    // millisecond before it and rejected with DeadlineExceeded at it. A virtual
    // clock stands in for 30 s of waiting.
    it("should enforce a default duration of 30000 ms", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const interceptor = createTimeoutInterceptor();
        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });
        const next = mock.fn(() => new Promise<never>(() => {}));

        let settled = false;
        const outcome = interceptor(next as any)(mockReq).then(
            () => {
                settled = true;
                return undefined;
            },
            (err: unknown) => {
                settled = true;
                return err;
            },
        );

        t.mock.timers.tick(29_999);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(settled, false, "the call must still be open 1 ms before the default limit");

        t.mock.timers.tick(1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(settled, true, "the call must be rejected at the default limit");
        const err = await outcome;

        assertConnectError(err, Code.DeadlineExceeded, "30000ms");
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

        // skipStreaming is not given: the default skips streaming calls, so the
        // downstream call outliving the 50 ms limit still answers.
        it("should pass through streaming request by default (skipStreaming not given)", async () => {
            const interceptor = createTimeoutInterceptor({ duration: 50 });

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

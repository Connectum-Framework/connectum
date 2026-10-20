/**
 * Bulkhead interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockNextError, createMockNextSlow, createMockRequest } from "@connectum/test-fixtures";
import { createBulkheadInterceptor } from "../../src/bulkhead.ts";

describe("bulkhead interceptor", () => {
    it("should pass request when under capacity", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 10 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("should queue request when at capacity", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 2, queueSize: 2 });

        let activeCount = 0;
        let maxActive = 0;
        const next = mock.fn(async () => {
            activeCount++;
            maxActive = Math.max(maxActive, activeCount);
            await new Promise((resolve) => setTimeout(resolve, 100));
            activeCount--;
            return { message: { result: "success" } };
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const handler = interceptor(next as any);

        // Start 3 concurrent requests (2 active, 1 queued)
        const promises = [handler(mockReq), handler(mockReq), handler(mockReq)];

        const results = await Promise.all(promises);
        assert.strictEqual(results.length, 3);
        results.forEach((r) => assert.strictEqual((r.message as any).result, "success"));
        // The third call was held back until a slot freed up, not run beside the first two.
        assert.strictEqual(maxActive, 2);
    });

    // capacity and queueSize both default to 10: ten calls run, ten wait, the
    // twenty-first is refused with the limits it was refused at.
    it("should admit 10 running and 10 queued calls by default and refuse the 21st", async () => {
        const interceptor = createBulkheadInterceptor();
        const gate = Promise.withResolvers<void>();
        const next = mock.fn(async () => {
            await gate.promise;
            return { message: { result: "success" } };
        });
        const handler = interceptor(next as any);
        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        // The refusal is immediate, so the outcomes are collected before anything is awaited.
        const settled = Promise.allSettled(Array.from({ length: 21 }, () => handler(mockReq)));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(next.mock.calls.length, 10, "only 10 calls may run at once");
        gate.resolve();
        const results = await settled;

        assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 20);
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        assert.strictEqual(rejected.length, 1);
        assertConnectError(rejected[0]!.reason, Code.ResourceExhausted, "Bulkhead capacity exceeded (capacity: 10, queueSize: 10)");
    });

    it("should reject request when queue full", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 1 });

        const next = createMockNextSlow(200);

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const handler = interceptor(next as any);

        // Start 3 requests (1 active, 1 queued, 1 rejected)
        const promises = [handler(mockReq), handler(mockReq), handler(mockReq)];

        // Third promise should be rejected
        const results = await Promise.allSettled(promises);
        const rejected = results.filter((r) => r.status === "rejected");
        assert.strictEqual(rejected.length, 1);
        const err = (rejected[0] as PromiseRejectedResult).reason;
        assertConnectError(err, Code.ResourceExhausted);
    });

    it("should convert BulkheadRejectedError to ResourceExhausted", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

        const next = createMockNextSlow(100);

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const handler = interceptor(next as any);

        // Start 2 concurrent requests (1 active, 1 rejected)
        const promises = [handler(mockReq), handler(mockReq)];

        // Second should be rejected (capacity=1, queueSize=0)
        const results = await Promise.allSettled(promises);
        const rejected = results.filter((r) => r.status === "rejected");
        assert.strictEqual(rejected.length, 1);
        const err = (rejected[0] as PromiseRejectedResult).reason;
        assertConnectError(err, Code.ResourceExhausted, "Bulkhead capacity exceeded");
    });

    it("should release slot on success", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);

        // First request should succeed
        const result1 = await handler(mockReq);
        assert.strictEqual((result1.message as any).result, "success");

        // Slot should be released - second request should also succeed
        const result2 = await handler(mockReq);
        assert.strictEqual((result2.message as any).result, "success");
    });

    it("should release slot on failure", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        // First request should fail
        await assert.rejects(() => handler(mockReq));

        // Slot should be released - second request should also fail (not rejected by bulkhead)
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Internal); // Service error, not ResourceExhausted
                return true;
            },
        );
    });

    it("should skip streaming when skipStreaming=true", async () => {
        // The only slot is held by a unary call and there is no queue: a streaming call that
        // went through the bulkhead would be rejected with ResourceExhausted. Skipped, it is not.
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0, skipStreaming: true });

        const gate = Promise.withResolvers<void>();
        const next = mock.fn(async (req: any) => {
            if (!req.stream) await gate.promise;
            return { stream: req.stream, message: { result: req.stream ? "streaming" : "unary" } };
        });
        const handler = interceptor(next as any);

        const unary = handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } }));
        const result = await handler(createMockRequest({ service: "test.Service", method: "StreamMethod", message: { field: "value" }, stream: true }));
        assert.strictEqual((result.message as any).result, "streaming");

        gate.resolve();
        assert.strictEqual(((await unary).message as any).result, "unary");
        assert.strictEqual(next.mock.calls.length, 2);
    });

    // skipStreaming is not given: streaming calls bypass the limit by default.
    it("should skip streaming by default", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

        const gate = Promise.withResolvers<void>();
        const next = mock.fn(async (req: any) => {
            if (!req.stream) await gate.promise;
            return { stream: req.stream, message: { result: req.stream ? "streaming" : "unary" } };
        });
        const handler = interceptor(next as any);

        const unary = handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } }));
        const result = await handler(createMockRequest({ service: "test.Service", method: "StreamMethod", message: { field: "value" }, stream: true }));
        assert.strictEqual((result.message as any).result, "streaming");

        gate.resolve();
        await unary;
    });

    // With skipStreaming: false a streaming call competes for the same slots as
    // a unary one.
    it("should apply the limit to streaming calls when skipStreaming=false", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0, skipStreaming: false });

        const gate = Promise.withResolvers<void>();
        const next = mock.fn(async (req: any) => {
            if (!req.stream) await gate.promise;
            return { stream: req.stream, message: { result: "ok" } };
        });
        const handler = interceptor(next as any);

        const unary = handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } }));
        await assert.rejects(
            () => handler(createMockRequest({ service: "test.Service", method: "StreamMethod", message: { field: "value" }, stream: true })),
            (err: unknown) => {
                assertConnectError(err, Code.ResourceExhausted, "Bulkhead capacity exceeded");
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 1, "the refused streaming call must not reach the handler");

        gate.resolve();
        await unary;
    });

    it("should handle custom capacity", async () => {
        // 12 is above the default capacity of 10, so ignoring the option would reject calls 11 and 12.
        const capacity = 12;
        const interceptor = createBulkheadInterceptor({ capacity, queueSize: 0 });

        let active = 0;
        let maxActive = 0;
        const next = mock.fn(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 50));
            active--;
            return { message: { result: "success" } };
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const handler = interceptor(next as any);

        // capacity + 1 concurrent calls and no queue: exactly `capacity` run, the extra one is refused
        const results = await Promise.allSettled(Array.from({ length: capacity + 1 }, () => handler(mockReq)));
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, capacity);
        assert.strictEqual(rejected.length, 1);
        assertConnectError(rejected[0]!.reason, Code.ResourceExhausted);
        assert.strictEqual(maxActive, capacity);
    });

    it("should handle custom queueSize", async () => {
        // capacity 1 runs one call at a time; queueSize 3 holds three more; the fifth is refused.
        // Ignoring queueSize (default 10) would queue the fifth call, ignoring capacity (default 10)
        // would run calls in parallel.
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 3 });

        let active = 0;
        let maxActive = 0;
        const next = mock.fn(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 30));
            active--;
            return { message: { result: "success" } };
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const handler = interceptor(next as any);

        const results = await Promise.allSettled(Array.from({ length: 5 }, () => handler(mockReq)));
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 4);
        assert.strictEqual(rejected.length, 1);
        assertConnectError(rejected[0]!.reason, Code.ResourceExhausted);
        assert.strictEqual(maxActive, 1);
    });

    it("should run queued requests one at a time after the active one finishes", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 2 });

        const events: string[] = [];
        const next = mock.fn(async (req: any) => {
            events.push(`start ${req.id}`);
            await new Promise((resolve) => setTimeout(resolve, 30));
            events.push(`end ${req.id}`);
            return { message: { result: req.id } };
        });

        const base = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });
        const handler = interceptor(next as any);

        await Promise.all([1, 2, 3].map((id) => handler({ ...base, id })));

        // A queued request starts only after the one holding the single slot has finished.
        // Which queued request goes first is deliberately not asserted: no document promises an order.
        const startsAndEnds = events.map((e) => e.split(" ")[0]);
        assert.deepStrictEqual(startsAndEnds, ["start", "end", "start", "end", "start", "end"]);
        assert.deepStrictEqual(events.filter((e) => e.startsWith("start")).sort(), ["start 1", "start 2", "start 3"]);
    });

    for (const [label, capacity, got] of [
        ["zero", 0, "0"],
        ["negative", -1, "-1"],
        ["infinite", Number.POSITIVE_INFINITY, "Infinity"],
        ["NaN", Number.NaN, "NaN"],
        ["fractional", 1.5, "1.5"],
    ] as const) {
        it(`should refuse a ${label} capacity with a RangeError naming the option and the value`, () => {
            assert.throws(
                () => createBulkheadInterceptor({ capacity }),
                (err: unknown) => err instanceof RangeError && err.message === `createBulkheadInterceptor: capacity must be an integer of at least 1, got ${got}`,
            );
        });
    }

    for (const [label, queueSize, got] of [
        ["negative", -1, "-1"],
        ["infinite", Number.POSITIVE_INFINITY, "Infinity"],
        ["fractional", 0.5, "0.5"],
    ] as const) {
        it(`should refuse a ${label} queueSize with a RangeError naming the option and the value`, () => {
            assert.throws(
                () => createBulkheadInterceptor({ queueSize }),
                (err: unknown) => err instanceof RangeError && err.message === `createBulkheadInterceptor: queueSize must be an integer of at least 0, got ${got}`,
            );
        });
    }

    it("should refuse a non-number capacity and queueSize with a TypeError", () => {
        assert.throws(
            () => createBulkheadInterceptor({ capacity: "5" as unknown as number }),
            (err: unknown) => err instanceof TypeError && err.message === 'createBulkheadInterceptor: capacity must be an integer of at least 1, got "5"',
        );
        assert.throws(
            () => createBulkheadInterceptor({ queueSize: null as unknown as number }),
            (err: unknown) => err instanceof TypeError && err.message === "createBulkheadInterceptor: queueSize must be an integer of at least 0, got null",
        );
    });

    it("should accept the boundary values capacity 1 and queueSize 0", () => {
        assert.strictEqual(typeof createBulkheadInterceptor({ capacity: 1, queueSize: 0 }), "function");
    });

    describe("capacity and queue overflow scenarios", () => {
        it("should immediately reject when queueSize=0 and capacity is full", async () => {
            const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

            const next = createMockNextSlow(200);

            const mockReq = createMockRequest({
                service: "test.Service",
                method: "Method",
                message: { field: "value" },
            });

            const handler = interceptor(next as any);

            // First request fills the capacity
            const p1 = handler(mockReq);
            // Second request should be immediately rejected (no queue)
            const p2 = handler(mockReq);

            const results = await Promise.allSettled([p1, p2]);
            const rejected = results.filter((r) => r.status === "rejected");
            assert.strictEqual(rejected.length, 1, "exactly one request should be rejected");

            const err = (rejected[0] as PromiseRejectedResult).reason;
            assertConnectError(err, Code.ResourceExhausted, "Bulkhead capacity exceeded");
        });

        it("should state the configured limits in the ResourceExhausted message when exceeding capacity + queue", async () => {
            const interceptor = createBulkheadInterceptor({ capacity: 2, queueSize: 1 });

            const next = createMockNextSlow(200);

            const mockReq = createMockRequest({
                service: "test.Service",
                method: "Method",
                message: { field: "value" },
            });

            const handler = interceptor(next as any);

            // 2 active + 1 queued + 1 overflow
            const promises = [handler(mockReq), handler(mockReq), handler(mockReq), handler(mockReq)];

            const results = await Promise.allSettled(promises);
            const rejected = results.filter((r) => r.status === "rejected");
            assert.strictEqual(rejected.length, 1, "exactly one request should be rejected");

            const err = (rejected[0] as PromiseRejectedResult).reason;
            assertConnectError(err, Code.ResourceExhausted);
            assert.ok(err instanceof ConnectError, "should be ConnectError");
            // The text carries the configured limits only: capacity 2, queue 1. Live counters of the
            // policy are free slots, which would read as an idle bulkhead at the moment it refuses.
            assert.strictEqual(err.rawMessage, "Bulkhead capacity exceeded (capacity: 2, queueSize: 1)");
        });

        it("should print the configured limits, not the occupancy, for a different configuration", async () => {
            const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });
            const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });
            const handler = interceptor(createMockNextSlow(100) as any);

            const results = await Promise.allSettled([handler(mockReq), handler(mockReq)]);
            const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
            assert.strictEqual(rejected.length, 1);
            assert.strictEqual((rejected[0]!.reason as ConnectError).rawMessage, "Bulkhead capacity exceeded (capacity: 1, queueSize: 0)");
        });
    });
});

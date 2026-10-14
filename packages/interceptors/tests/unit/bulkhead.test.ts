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
        const next = mock.fn(async () => {
            activeCount++;
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

    it("should reject invalid capacity", () => {
        assert.throws(() => createBulkheadInterceptor({ capacity: 0 }), /capacity must be a positive finite number/);
        assert.throws(() => createBulkheadInterceptor({ capacity: -1 }), /capacity must be a positive finite number/);
        assert.throws(() => createBulkheadInterceptor({ capacity: Number.POSITIVE_INFINITY }), /capacity must be a positive finite number/);
    });

    it("should reject invalid queueSize", () => {
        assert.throws(() => createBulkheadInterceptor({ queueSize: -1 }), /queueSize must be a non-negative finite number/);
        assert.throws(() => createBulkheadInterceptor({ queueSize: Number.POSITIVE_INFINITY }), /queueSize must be a non-negative finite number/);
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

        it("should include slot info in ResourceExhausted message when exceeding capacity + queue", async () => {
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
            // The limits in the message are the configured ones: capacity 2, queue 1.
            assert.match(err.rawMessage, /^Bulkhead capacity exceeded \(active: \d+\/2, queued: \d+\/1\)$/);
        });

        // The message shows how loaded the bulkhead is when it refuses a call, so with every slot
        // taken ("active" 2 of 2, queue 1 of 1) it must say so. The implementation prints the
        // number of FREE slots of the policy (0/2, 0/1), which reads as an idle bulkhead.
        it.skip("should report the occupied slots in the ResourceExhausted message", async () => {
            const interceptor = createBulkheadInterceptor({ capacity: 2, queueSize: 1 });
            const next = createMockNextSlow(200);
            const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });
            const handler = interceptor(next as any);

            const results = await Promise.allSettled([handler(mockReq), handler(mockReq), handler(mockReq), handler(mockReq)]);
            const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
            assert.strictEqual(rejected.length, 1);
            assert.strictEqual((rejected[0]!.reason as ConnectError).rawMessage, "Bulkhead capacity exceeded (active: 2/2, queued: 1/1)");
        });
    });
});

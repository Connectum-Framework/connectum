/**
 * Bulkhead interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createBulkheadInterceptor } from "../../src/bulkhead.ts";

describe("bulkhead interceptor", () => {
    it("should pass request when under capacity", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 10 });

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

    it("should queue request when at capacity", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 2, queueSize: 2 });

        let activeCount = 0;
        const next = mock.fn(async () => {
            activeCount++;
            await new Promise((resolve) => setTimeout(resolve, 100));
            activeCount--;
            return { message: { result: "success" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Start 3 concurrent requests (2 active, 1 queued)
        const promises = [handler(mockReq), handler(mockReq), handler(mockReq)];

        const results = await Promise.all(promises);
        assert.strictEqual(results.length, 3);
        results.forEach((r) => assert.strictEqual((r.message as any).result, "success"));
    });

    it("should reject request when queue full", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 1 });

        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { message: { result: "success" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Start 3 requests (1 active, 1 queued, 1 rejected)
        const promises = [handler(mockReq), handler(mockReq), handler(mockReq)];

        // Third promise should be rejected
        const results = await Promise.allSettled(promises);
        const rejected = results.filter((r) => r.status === "rejected");
        assert.strictEqual(rejected.length, 1);
        const err = (rejected[0] as PromiseRejectedResult).reason;
        assert(err instanceof ConnectError);
        assert.strictEqual((err as ConnectError).code, Code.ResourceExhausted);
    });

    it("should convert BulkheadRejectedError to ResourceExhausted", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { message: { result: "success" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // Start 2 concurrent requests (1 active, 1 rejected)
        const promises = [handler(mockReq), handler(mockReq)];

        // Second should be rejected (capacity=1, queueSize=0)
        const results = await Promise.allSettled(promises);
        const rejected = results.filter((r) => r.status === "rejected");
        assert.strictEqual(rejected.length, 1);
        const err = (rejected[0] as PromiseRejectedResult).reason;
        assert(err instanceof ConnectError);
        assert.strictEqual((err as ConnectError).code, Code.ResourceExhausted);
        assert((err as ConnectError).message.includes("Bulkhead capacity exceeded"));
    });

    it("should release slot on success", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 0 });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => ({ message: { result: "success" } }));

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

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError("Service error", Code.Internal);
        });

        const handler = interceptor(next as any);

        // First request should fail
        await assert.rejects(() => handler(mockReq));

        // Slot should be released - second request should also fail (not rejected by bulkhead)
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert.strictEqual((err as ConnectError).code, Code.Internal); // Service error, not ResourceExhausted
                return true;
            },
        );
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, skipStreaming: true });

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

    it("should handle custom capacity", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 5, queueSize: 0 });

        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { message: { result: "success" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // 5 concurrent requests should succeed
        const promises = Array.from({ length: 5 }, () => handler(mockReq));
        const results = await Promise.all(promises);
        assert.strictEqual(results.length, 5);
    });

    it("should handle custom queueSize", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 3 });

        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { message: { result: "success" } };
        });

        const mockReq = {
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any;

        const handler = interceptor(next as any);

        // 4 requests should succeed (1 active, 3 queued)
        const promises = Array.from({ length: 4 }, () => handler(mockReq));
        const results = await Promise.all(promises);
        assert.strictEqual(results.length, 4);
    });

    it("should process queued requests in order", async () => {
        const interceptor = createBulkheadInterceptor({ capacity: 1, queueSize: 2 });

        const order: number[] = [];
        const next = mock.fn(async (req: any) => {
            order.push(req.id || 0);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { message: { result: req.id } };
        });

        const mockReq1 = {
            id: 1,
            url: "http://localhost/test.Service/Method",
            stream: false,
            message: { field: "value" },
            service: { typeName: "test.Service" },
        } as any & { id: number };

        const mockReq2 = { ...mockReq1, id: 2 };
        const mockReq3 = { ...mockReq1, id: 3 };

        const handler = interceptor(next as any);

        const promises = [handler(mockReq1), handler(mockReq2), handler(mockReq3)];

        await Promise.all(promises);
        assert.deepStrictEqual(order, [1, 2, 3]);
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
});

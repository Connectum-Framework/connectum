/**
 * Method filter interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { createMethodFilterInterceptor } from "../../src/method-filter.ts";

/**
 * Helper: create a mock request with the given service and method names.
 */
function createMockReq(serviceName: string, methodName: string, extra: Record<string, unknown> = {}) {
    return {
        url: `http://localhost/${serviceName}/${methodName}`,
        stream: false,
        message: { field: "value" },
        service: { typeName: serviceName },
        method: { name: methodName },
        ...extra,
    } as any;
}

/**
 * Helper: create a tracking interceptor that records calls.
 */
function createTrackingInterceptor(name: string, calls: string[]): Interceptor {
    return (next) => async (req) => {
        calls.push(name);
        return await next(req);
    };
}

describe("createMethodFilterInterceptor", () => {
    describe("pattern matching", () => {
        it("should match global wildcard '*'", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "*": [createTrackingInterceptor("global", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, ["global"]);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should match service wildcard 'Service/*'", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "user.v1.UserService/*": [createTrackingInterceptor("service", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, ["service"]);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should match exact pattern 'Service/Method'", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "user.v1.UserService/GetUser": [createTrackingInterceptor("exact", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, ["exact"]);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should not match unrelated service wildcard", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "admin.v1.AdminService/*": [createTrackingInterceptor("admin", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, []);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should not match unrelated exact pattern", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "user.v1.UserService/DeleteUser": [createTrackingInterceptor("delete", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, []);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("execution order", () => {
        it("should execute in order: global -> service -> exact", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "*": [createTrackingInterceptor("global", calls)],
                "user.v1.UserService/*": [createTrackingInterceptor("service", calls)],
                "user.v1.UserService/GetUser": [createTrackingInterceptor("exact", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, ["global", "service", "exact"]);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should execute multiple interceptors within same pattern in array order", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "*": [
                    createTrackingInterceptor("global-1", calls),
                    createTrackingInterceptor("global-2", calls),
                ],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, ["global-1", "global-2"]);
        });

        it("should execute global and exact (no service wildcard defined)", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "*": [createTrackingInterceptor("global", calls)],
                "user.v1.UserService/GetUser": [createTrackingInterceptor("exact", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            await handler(mockReq);

            assert.deepStrictEqual(calls, ["global", "exact"]);
        });
    });

    describe("pass-through behavior", () => {
        it("should pass through when no patterns match", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "admin.v1.AdminService/*": [createTrackingInterceptor("admin", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.deepStrictEqual(calls, []);
            assert.strictEqual((result.message as any).result, "ok");
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should pass through with empty MethodFilterMap", async () => {
            const interceptor = createMethodFilterInterceptor({});

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual((result.message as any).result, "ok");
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should pass through with empty interceptor array", async () => {
            const interceptor = createMethodFilterInterceptor({
                "*": [],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual((result.message as any).result, "ok");
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("error propagation", () => {
        it("should propagate errors from matched interceptors", async () => {
            const errorInterceptor: Interceptor = (_next) => async (_req) => {
                throw new Error("interceptor error");
            };

            const interceptor = createMethodFilterInterceptor({
                "*": [errorInterceptor],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);

            await assert.rejects(() => handler(mockReq), (err: unknown) => {
                assert(err instanceof Error);
                assert.strictEqual(err.message, "interceptor error");
                return true;
            });
        });

        it("should propagate errors from next handler through interceptors", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "*": [createTrackingInterceptor("global", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => {
                throw new Error("handler error");
            });

            const handler = interceptor(next as any);

            await assert.rejects(() => handler(mockReq), (err: unknown) => {
                assert(err instanceof Error);
                assert.strictEqual(err.message, "handler error");
                return true;
            });

            assert.deepStrictEqual(calls, ["global"]);
        });
    });

    describe("pattern validation", () => {
        it("should throw on invalid pattern format", () => {
            assert.throws(
                () => createMethodFilterInterceptor({ "invalid-pattern": [] }),
                /Invalid method filter pattern: "invalid-pattern"/,
            );
        });

        it("should throw on empty service name before '/*'", () => {
            assert.throws(
                () => createMethodFilterInterceptor({ "/*": [] }),
                /Service name before "\/\*" must not be empty/,
            );
        });

        it("should accept valid patterns without throwing", () => {
            assert.doesNotThrow(() =>
                createMethodFilterInterceptor({
                    "*": [],
                    "my.Service/*": [],
                    "my.Service/Method": [],
                }),
            );
        });
    });

    describe("interceptor chaining", () => {
        it("should properly chain interceptors with request modification", async () => {
            const addHeader: Interceptor = (next) => async (req: any) => {
                const modifiedReq = { ...req, header: "added" };
                return await next(modifiedReq);
            };

            const interceptor = createMethodFilterInterceptor({
                "*": [addHeader],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async (req: any) => ({
                message: { header: req.header },
            }));

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual((result.message as any).header, "added");
        });

        it("should properly chain interceptors with response modification", async () => {
            const addResponseHeader: Interceptor = (next) => async (req) => {
                const res = await next(req);
                return { ...res, modified: true };
            };

            const interceptor = createMethodFilterInterceptor({
                "*": [addResponseHeader],
            });

            const mockReq = createMockReq("user.v1.UserService", "GetUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));

            const handler = interceptor(next as any);
            const result = (await handler(mockReq)) as any;

            assert.strictEqual(result.modified, true);
            assert.strictEqual(result.message.result, "ok");
        });
    });

    describe("multiple services", () => {
        it("should route to correct service interceptors", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "user.v1.UserService/*": [createTrackingInterceptor("user", calls)],
                "admin.v1.AdminService/*": [createTrackingInterceptor("admin", calls)],
            });

            // User service request
            const userReq = createMockReq("user.v1.UserService", "GetUser");
            const next1 = mock.fn(async () => ({ message: { result: "ok" } }));
            await interceptor(next1 as any)(userReq);

            assert.deepStrictEqual(calls, ["user"]);

            // Admin service request
            calls.length = 0;
            const adminReq = createMockReq("admin.v1.AdminService", "DeleteUser");
            const next2 = mock.fn(async () => ({ message: { result: "ok" } }));
            await interceptor(next2 as any)(adminReq);

            assert.deepStrictEqual(calls, ["admin"]);
        });

        it("should handle multiple exact patterns for same service", async () => {
            const calls: string[] = [];
            const interceptor = createMethodFilterInterceptor({
                "user.v1.UserService/GetUser": [createTrackingInterceptor("get", calls)],
                "user.v1.UserService/DeleteUser": [createTrackingInterceptor("delete", calls)],
            });

            const mockReq = createMockReq("user.v1.UserService", "DeleteUser");
            const next = mock.fn(async () => ({ message: { result: "ok" } }));
            await interceptor(next as any)(mockReq);

            assert.deepStrictEqual(calls, ["delete"]);
        });
    });

    describe("reusability", () => {
        it("should be reusable across multiple requests", async () => {
            let callCount = 0;
            const counting: Interceptor = (next) => async (req) => {
                callCount++;
                return await next(req);
            };

            const interceptor = createMethodFilterInterceptor({
                "*": [counting],
            });

            const next = mock.fn(async () => ({ message: { result: "ok" } }));
            const handler = interceptor(next as any);

            const req1 = createMockReq("svc.A", "M1");
            const req2 = createMockReq("svc.B", "M2");
            const req3 = createMockReq("svc.A", "M1");

            await handler(req1);
            await handler(req2);
            await handler(req3);

            assert.strictEqual(callCount, 3);
            assert.strictEqual(next.mock.calls.length, 3);
        });
    });
});

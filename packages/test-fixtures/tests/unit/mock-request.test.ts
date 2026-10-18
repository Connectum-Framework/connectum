import assert from "node:assert";
import { before, describe, it } from "node:test";
import { createMockRequest } from "../../src/mock-request.ts";
import { type ObservedCall, observeRealCalls, REAL_METHODS } from "./support/real-protobuf.ts";

// Expected values come from the request that a client interceptor receives from
// a real transport (tests/unit/support/real-protobuf.ts), not from the factory.

describe("createMockRequest", () => {
    let unary: ObservedCall;
    let serverStreaming: ObservedCall;

    before(async () => {
        ({ unary, serverStreaming } = await observeRealCalls());
    });

    it("returns valid request with all defaults", () => {
        const req = createMockRequest();

        assert.ok(req.service, "service must be defined");
        assert.ok(req.method, "method must be defined");
        assert.ok(req.header instanceof Headers, "header must be a Headers instance");
        assert.ok(req.signal instanceof AbortSignal, "signal must be an AbortSignal instance");
        assert.strictEqual(req.signal.aborted, false);
        assert.strictEqual(typeof req.url, "string");
        assert.strictEqual(req.stream, false);
        assert.deepStrictEqual(req.message, {});
    });

    // A real request addresses its call as `<origin>/<service typeName>/<method name>`
    // (Connect protocol). The origin differs, so only the path is compared.
    it("auto-generates url from default service and method", () => {
        const req = createMockRequest();

        assert.strictEqual(new URL(req.url).pathname, `/${req.service.typeName}/${req.method.name}`);
        assert.strictEqual(req.service.typeName, "test.TestService");
        assert.strictEqual(req.method.name, "TestMethod");
        assert.strictEqual(new URL(req.url).pathname, "/test.TestService/TestMethod");
    });

    it(
        "auto-generated url has the same origin as the url of a real in-process request",
        { skip: "the factory builds http://localhost/... while an in-process transport request carries https://in-memory/...; which origin a mock must carry is an owner decision" },
        () => {
            const req = createMockRequest({ service: unary.req.service.typeName, method: unary.req.method.name });

            assert.strictEqual(req.url, unary.req.url);
        },
    );

    it("allocates independent live cancellation signals for separate requests", () => {
        const first = createMockRequest();
        const second = createMockRequest();

        assert.notStrictEqual(first.signal, second.signal);
        assert.strictEqual(first.signal.aborted, false);
        assert.strictEqual(second.signal.aborted, false);
    });

    it("custom service name flows into service.typeName and url path, as in the real request", () => {
        for (const real of [unary.req, serverStreaming.req]) {
            const req = createMockRequest({ service: real.service.typeName });

            assert.strictEqual(req.service.typeName, real.service.typeName);
            assert.strictEqual(new URL(req.url).pathname, `/${real.service.typeName}/TestMethod`);
            assert.strictEqual(req.method.name, "TestMethod", "service option must not touch the method");
        }
    });

    for (const { name } of REAL_METHODS) {
        it(`custom method name flows into method.name and the url path, as in the real request: ${name}`, () => {
            const req = createMockRequest({ method: name });

            assert.strictEqual(req.method.name, name);
            assert.strictEqual(new URL(req.url).pathname, `/test.TestService/${name}`);
            assert.strictEqual(req.service.typeName, "test.TestService", "method option must not touch the service");
        });
    }

    it("service and method of a real request map to the same fields of the mock", () => {
        for (const real of [unary.req, serverStreaming.req]) {
            const req = createMockRequest({ service: real.service.typeName, method: real.method.name });

            assert.strictEqual(req.service.typeName, real.service.typeName);
            assert.strictEqual(req.method.name, real.method.name);
            assert.strictEqual(new URL(req.url).pathname, new URL(real.url).pathname);
        }
    });

    it("custom message is set", () => {
        const payload = { id: 42, name: "Alice" };
        const req = createMockRequest({ message: payload });

        assert.deepStrictEqual(req.message, payload);
    });

    it("stream defaults to the flag of a real unary request and stream: true to that of a real streaming request", () => {
        assert.strictEqual(unary.req.stream, false, "reference: a unary request is not a stream");
        assert.strictEqual(serverStreaming.req.stream, true, "reference: a server-streaming request is a stream");

        assert.strictEqual(createMockRequest().stream, unary.req.stream);
        assert.strictEqual(createMockRequest({ stream: false }).stream, unary.req.stream);
        assert.strictEqual(createMockRequest({ stream: true }).stream, serverStreaming.req.stream);
    });

    it("custom url overrides auto-generated url", () => {
        const req = createMockRequest({ url: unary.req.url });

        assert.strictEqual(req.url, unary.req.url);
        assert.strictEqual(req.service.typeName, "test.TestService", "url option must not rewrite the service");
        assert.strictEqual(req.method.name, "TestMethod", "url option must not rewrite the method");
    });

    it("custom headers are set", () => {
        const headers = new Headers({ authorization: "Bearer token123" });
        const req = createMockRequest({ headers });

        assert.strictEqual(req.header.get("authorization"), "Bearer token123");
        assert.strictEqual(req.header, headers, "the supplied Headers object is used as is, so later edits stay visible to the test");
    });

    it("default headers are an empty Headers object, like the request of a call made without headers", () => {
        assert.ok(unary.req.header instanceof Headers, "reference: a real request carries a Headers object");

        const req = createMockRequest();

        assert.ok(req.header instanceof Headers);
        assert.deepStrictEqual([...req.header.keys()], []);
        assert.notStrictEqual(createMockRequest().header, req.header, "requests must not share one default Headers object");
    });

    it("all options at once", () => {
        const headers = new Headers({ "x-request-id": "abc-123" });
        const req = createMockRequest({
            service: "billing.v1.InvoiceService",
            method: "CreateInvoice",
            message: { amount: 100 },
            stream: true,
            url: "https://billing.local/rpc",
            headers,
        });

        assert.strictEqual(req.service.typeName, "billing.v1.InvoiceService");
        assert.strictEqual(req.method.name, "CreateInvoice");
        assert.deepStrictEqual(req.message, { amount: 100 });
        assert.strictEqual(req.stream, true);
        assert.strictEqual(req.url, "https://billing.local/rpc");
        assert.strictEqual(req.header.get("x-request-id"), "abc-123");
    });

    it("calling with no arguments works (all defaults)", () => {
        const req = createMockRequest();

        assert.strictEqual(req.service.typeName, "test.TestService");
        assert.strictEqual(req.method.name, "TestMethod");
        assert.strictEqual(req.url, "http://localhost/test.TestService/TestMethod");
        assert.strictEqual(req.stream, false);
        assert.deepStrictEqual(req.message, {});
        assert.ok(req.header instanceof Headers);
        assert.deepStrictEqual([...req.header.entries()], []);
    });
});

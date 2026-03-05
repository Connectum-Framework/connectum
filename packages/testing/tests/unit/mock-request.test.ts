import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockRequest } from "../../src/mock-request.ts";

describe("createMockRequest", () => {
  it("returns valid request with all defaults", () => {
    const req = createMockRequest();

    assert.ok(req.service, "service must be defined");
    assert.ok(req.method, "method must be defined");
    assert.ok(req.header instanceof Headers, "header must be a Headers instance");
    assert.strictEqual(typeof req.url, "string");
    assert.strictEqual(req.stream, false);
    assert.deepStrictEqual(req.message, {});
  });

  it("auto-generates url from default service and method", () => {
    const req = createMockRequest();

    assert.strictEqual(req.url, "http://localhost/test.TestService/TestMethod");
  });

  it("custom service name flows into service.typeName and url", () => {
    const req = createMockRequest({ service: "acme.UserService" });

    assert.strictEqual(req.service.typeName, "acme.UserService");
    assert.strictEqual(req.url, "http://localhost/acme.UserService/TestMethod");
  });

  it("custom method name flows into method.name and url", () => {
    const req = createMockRequest({ method: "GetUser" });

    assert.strictEqual(req.method.name, "GetUser");
    assert.strictEqual(req.url, "http://localhost/test.TestService/GetUser");
  });

  it("custom message is set", () => {
    const payload = { id: 42, name: "Alice" };
    const req = createMockRequest({ message: payload });

    assert.deepStrictEqual(req.message, payload);
  });

  it("stream: true works", () => {
    const req = createMockRequest({ stream: true });

    assert.strictEqual(req.stream, true);
  });

  it("custom url overrides auto-generated url", () => {
    const customUrl = "https://api.example.com/custom/path";
    const req = createMockRequest({
      service: "acme.UserService",
      method: "GetUser",
      url: customUrl,
    });

    assert.strictEqual(req.url, customUrl);
  });

  it("custom headers are set", () => {
    const headers = new Headers({ authorization: "Bearer token123" });
    const req = createMockRequest({ headers });

    assert.strictEqual(req.header.get("authorization"), "Bearer token123");
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

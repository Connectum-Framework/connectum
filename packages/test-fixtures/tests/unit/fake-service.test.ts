import assert from "node:assert";
import { describe, it } from "node:test";
import { createFakeMethod, createFakeService } from "../../src/fake-service.ts";

describe("createFakeService", () => {
  it("creates service with default typeName", () => {
    const svc = createFakeService();

    assert.strictEqual(svc.typeName, "test.v1.TestService");
  });

  it("creates service with custom typeName", () => {
    const svc = createFakeService({ typeName: "acme.v1.UserService" });

    assert.strictEqual(svc.typeName, "acme.v1.UserService");
  });

  it("derives name from typeName (last segment)", () => {
    const svc = createFakeService({ typeName: "acme.v1.UserService" });

    assert.strictEqual(svc.name, "UserService");
  });

  it("custom name overrides derived name", () => {
    const svc = createFakeService({
      typeName: "acme.v1.UserService",
      name: "CustomName",
    });

    assert.strictEqual(svc.name, "CustomName");
  });

  it("has empty methods array", () => {
    const svc = createFakeService();

    assert.deepStrictEqual(svc.methods, []);
  });

  it("has empty method map", () => {
    const svc = createFakeService();

    assert.deepStrictEqual(svc.method, {});
  });

  it("has kind 'service'", () => {
    const svc = createFakeService();

    assert.strictEqual(svc.kind, "service");
  });
});

describe("createFakeMethod", () => {
  it("creates method with correct name", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "GetUser");

    assert.strictEqual(method.name, "GetUser");
  });

  it("localName is camelCase (first char lowered)", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "GetUser");

    assert.strictEqual(method.localName, "getUser");
  });

  it("parent references the service", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "GetUser");

    assert.strictEqual(method.parent, svc);
  });

  it("default methodKind is 'unary'", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "GetUser");

    assert.strictEqual(method.methodKind, "unary");
  });

  it("custom methodKind works", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "StreamEvents", {
      methodKind: "server_streaming",
    });

    assert.strictEqual(method.methodKind, "server_streaming");
  });

  it("register: true pushes method into service.methods array", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "GetUser", { register: true });

    assert.strictEqual(svc.methods.length, 1);
    assert.strictEqual(svc.methods[0], method);
  });

  it("register: true adds method to service.method map by localName", () => {
    const svc = createFakeService();
    const method = createFakeMethod(svc, "GetUser", { register: true });

    assert.strictEqual(svc.method.getUser, method);
  });

  it("register: false (default) does NOT modify service", () => {
    const svc = createFakeService();
    createFakeMethod(svc, "GetUser");

    assert.strictEqual(svc.methods.length, 0);
    assert.deepStrictEqual(svc.method, {});
  });

  it("multiple methods can be registered to same service", () => {
    const svc = createFakeService();
    const m1 = createFakeMethod(svc, "GetUser", { register: true });
    const m2 = createFakeMethod(svc, "ListUsers", {
      register: true,
      methodKind: "server_streaming",
    });
    const m3 = createFakeMethod(svc, "DeleteUser", { register: true });

    assert.strictEqual(svc.methods.length, 3);
    assert.strictEqual(svc.methods[0], m1);
    assert.strictEqual(svc.methods[1], m2);
    assert.strictEqual(svc.methods[2], m3);
    assert.strictEqual(svc.method.getUser, m1);
    assert.strictEqual(svc.method.listUsers, m2);
    assert.strictEqual(svc.method.deleteUser, m3);
  });
});

import assert from "node:assert";
import { describe, it } from "node:test";
import { createFakeMethod, createFakeService } from "../../src/fake-service.ts";
import { REAL_METHODS, realMethod, realService } from "./support/real-protobuf.ts";

// Expected values come from descriptors compiled by the real @bufbuild/protobuf
// registry (tests/unit/support/real-protobuf.ts), not from the factory itself.

describe("createFakeService", () => {
  it("creates service with default typeName", () => {
    const svc = createFakeService();

    assert.strictEqual(svc.typeName, "test.v1.TestService");
  });

  for (const typeName of ["acme.v1.UserService", "Standalone"]) {
    it(`creates service with custom typeName that matches the real descriptor of ${typeName}`, () => {
      const real = realService(typeName);

      const svc = createFakeService({ typeName: real.typeName });

      assert.strictEqual(svc.kind, real.kind);
      assert.strictEqual(svc.typeName, real.typeName);
      assert.strictEqual(svc.name, real.name);
      assert.strictEqual(svc.deprecated, real.deprecated);
    });
  }

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

  it("custom name does not change typeName", () => {
    // typeName keeps its documented default when only the short name is given,
    // and an explicit typeName is never rewritten by the name option.
    assert.strictEqual(createFakeService({ name: "CustomName" }).typeName, "test.v1.TestService");
    assert.strictEqual(createFakeService({ typeName: "acme.v1.UserService", name: "CustomName" }).typeName, "acme.v1.UserService");
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
  for (const { name } of REAL_METHODS) {
    it(`creates method with correct name: ${name}`, () => {
      const real = realMethod(name);
      const svc = createFakeService();

      const method = createFakeMethod(svc, real.name);

      assert.strictEqual(method.name, real.name);
      assert.strictEqual(method.kind, real.kind);
      assert.strictEqual(method.deprecated, real.deprecated);
    });
  }

  // protobuf-es lowers only the first character of an RPC name; it does not
  // re-case word boundaries (`URLFetch` -> `uRLFetch`) and leaves a name that
  // already starts in lower case unchanged.
  for (const { name } of REAL_METHODS.filter((m) => m.name !== "ToString")) {
    it(`localName is camelCase (first char lowered): ${name}`, () => {
      const method = createFakeMethod(createFakeService(), name);

      assert.strictEqual(method.localName, realMethod(name).localName);
    });
  }

  // protobuf-es escapes localNames that collide with built-in object properties
  // (constructor, toString, toJSON, valueOf) by appending "$"; the factory does not.
  it(
    "localName escapes names that collide with built-in object properties",
    () => {
      const method = createFakeMethod(createFakeService(), "ToString");

      assert.strictEqual(method.localName, realMethod("ToString").localName);
    },
  );

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

  for (const kind of ["unary", "server_streaming", "client_streaming", "bidi_streaming"] as const) {
    it(`custom methodKind works: ${kind}`, () => {
      const real = REAL_METHODS.find((m) => m.kind === kind);
      assert.ok(real, `no reference RPC of kind ${kind}`);
      assert.strictEqual(realMethod(real.name).methodKind, kind, "reference descriptor must report the same kind");

      const method = createFakeMethod(createFakeService(), real.name, { methodKind: kind });

      assert.strictEqual(method.methodKind, realMethod(real.name).methodKind);
    });
  }

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

  // The generated API reference states that the `methods` array and the `method`
  // lookup start empty and are populated only by `register: true`.
  it("register: false (default) does NOT modify service", () => {
    const svc = createFakeService();
    createFakeMethod(svc, "GetUser");
    createFakeMethod(svc, "ListUsers", { register: false });

    assert.strictEqual(svc.methods.length, 0);
    assert.deepStrictEqual(svc.method, {});
  });

  it("an unregistered method stays out of a service that already has registered methods", () => {
    const svc = createFakeService();
    const registered = createFakeMethod(svc, "GetUser", { register: true });

    createFakeMethod(svc, "ListUsers");
    createFakeMethod(svc, "DeleteUser", { register: false });

    assert.deepStrictEqual(svc.methods, [registered]);
    assert.deepStrictEqual(Object.keys(svc.method), ["getUser"]);
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

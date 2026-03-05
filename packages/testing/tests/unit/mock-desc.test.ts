import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createMockDescField,
  createMockDescMessage,
  createMockDescMethod,
} from "../../src/mock-desc.ts";

// ============================================================
// createMockDescMessage
// ============================================================

describe("createMockDescMessage", () => {
  it("creates message with correct typeName and name", () => {
    const msg = createMockDescMessage("acme.v1.User");

    assert.strictEqual(msg.typeName, "acme.v1.User");
    assert.strictEqual(msg.name, "User");
  });

  it("has members: [] (critical for @bufbuild/protobuf create())", () => {
    const msg = createMockDescMessage("test.Msg");

    assert.ok(Array.isArray((msg as any).members), "members must be an array");
    assert.strictEqual((msg as any).members.length, 0);
  });

  it("has fields: [] by default", () => {
    const msg = createMockDescMessage("test.Empty");

    assert.ok(Array.isArray(msg.fields));
    assert.strictEqual(msg.fields.length, 0);
  });

  it("creates fields from options", () => {
    const msg = createMockDescMessage("test.WithFields", {
      fields: [
        { name: "id", type: "int32" },
        { name: "email", type: "string" },
      ],
    });

    assert.strictEqual(msg.fields.length, 2);
    assert.strictEqual(msg.fields[0]!.localName, "id");
    assert.strictEqual(msg.fields[1]!.localName, "email");
  });

  it("field object maps localName to DescField", () => {
    const msg = createMockDescMessage("test.Mapped", {
      fields: [
        { name: "userId", type: "int32" },
        { name: "name", type: "string" },
      ],
    });

    assert.ok((msg as any).field.userId, "field.userId must exist");
    assert.strictEqual((msg as any).field.userId.localName, "userId");
    assert.ok((msg as any).field.name, "field.name must exist");
    assert.strictEqual((msg as any).field.name.localName, "name");
  });

  it("has required structural properties", () => {
    const msg = createMockDescMessage("test.Structural") as any;

    assert.strictEqual(msg.kind, "message");
    assert.ok(Array.isArray(msg.nestedEnums), "nestedEnums must be an array");
    assert.ok(
      Array.isArray(msg.nestedMessages),
      "nestedMessages must be an array",
    );
    assert.ok(
      Array.isArray(msg.nestedExtensions),
      "nestedExtensions must be an array",
    );
    assert.ok(Array.isArray(msg.oneofs), "oneofs must be an array");
    assert.strictEqual(msg.parent, undefined);
  });

  it("generates file name from typeName", () => {
    const msg = createMockDescMessage("acme.v1.UserService") as any;

    assert.strictEqual(msg.file.name, "acme/v1/UserService.proto");
  });

  it("creates oneofs from options", () => {
    const msg = createMockDescMessage("test.WithOneof", {
      oneofs: ["credentials"],
    }) as any;

    assert.strictEqual(msg.oneofs.length, 1);
    assert.strictEqual(msg.oneofs[0].name, "credentials");
    assert.strictEqual(msg.oneofs[0].localName, "credentials");
    assert.strictEqual(msg.oneofs[0].kind, "oneof");
    assert.ok(Array.isArray(msg.oneofs[0].fields));
  });

  it("auto-increments fieldNumber when not specified", () => {
    const msg = createMockDescMessage("test.AutoNum", {
      fields: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });

    assert.strictEqual(msg.fields[0]!.number, 1);
    assert.strictEqual(msg.fields[1]!.number, 2);
    assert.strictEqual(msg.fields[2]!.number, 3);
  });

  it("uses explicit fieldNumber when specified", () => {
    const msg = createMockDescMessage("test.ExplicitNum", {
      fields: [{ name: "x", fieldNumber: 10 }],
    });

    assert.strictEqual(msg.fields[0]!.number, 10);
  });

  it("derives name from last segment of typeName", () => {
    assert.strictEqual(
      createMockDescMessage("a.b.c.DeepMessage").name,
      "DeepMessage",
    );
    assert.strictEqual(createMockDescMessage("Simple").name, "Simple");
  });
});

// ============================================================
// createMockDescField
// ============================================================

describe("createMockDescField", () => {
  it("creates field with correct localName", () => {
    const field = createMockDescField("username");

    assert.strictEqual(field.localName, "username");
    assert.strictEqual((field as any).name, "username");
    assert.strictEqual((field as any).jsonName, "username");
  });

  it("default scalar is string (9)", () => {
    const field = createMockDescField("text");

    assert.strictEqual((field as any).scalar, 9);
  });

  it("custom type maps correctly: bool -> 8", () => {
    const field = createMockDescField("active", { type: "bool" });

    assert.strictEqual((field as any).scalar, 8);
  });

  it("custom type maps correctly: int32 -> 5", () => {
    const field = createMockDescField("count", { type: "int32" });

    assert.strictEqual((field as any).scalar, 5);
  });

  it("unknown type defaults to string (9)", () => {
    const field = createMockDescField("data", { type: "unknown_type" });

    assert.strictEqual((field as any).scalar, 9);
  });

  it("fieldNumber defaults to 1", () => {
    const field = createMockDescField("value");

    assert.strictEqual(field.number, 1);
  });

  it("custom fieldNumber is set", () => {
    const field = createMockDescField("value", { fieldNumber: 42 });

    assert.strictEqual(field.number, 42);
  });

  it("isSensitive sets debug_redact in proto options", () => {
    const field = createMockDescField("password", { isSensitive: true });

    assert.strictEqual((field as any).proto.options.debug_redact, true);
  });

  it("non-sensitive field has undefined proto options", () => {
    const field = createMockDescField("username");

    assert.strictEqual((field as any).proto.options, undefined);
  });

  it("has correct structural defaults", () => {
    const field = createMockDescField("f") as any;

    assert.strictEqual(field.kind, "field");
    assert.strictEqual(field.fieldKind, "scalar");
    assert.strictEqual(field.repeated, false);
    assert.strictEqual(field.packed, false);
    assert.strictEqual(field.optional, false);
    assert.strictEqual(field.parent, undefined);
    assert.strictEqual(field.oneof, undefined);
  });
});

// ============================================================
// createMockDescMethod
// ============================================================

describe("createMockDescMethod", () => {
  it("creates method with correct name", () => {
    const method = createMockDescMethod("GetUser");

    assert.strictEqual(method.name, "GetUser");
  });

  it("localName is camelCase (first char lowered)", () => {
    const method = createMockDescMethod("GetUser");

    assert.strictEqual((method as any).localName, "getUser");
  });

  it("default methodKind is unary", () => {
    const method = createMockDescMethod("Ping");

    assert.strictEqual(method.methodKind, "unary");
  });

  it("custom methodKind is set", () => {
    const method = createMockDescMethod("ListUsers", {
      kind: "server_streaming",
    });

    assert.strictEqual(method.methodKind, "server_streaming");
  });

  it("custom input/output DescMessage", () => {
    const input = createMockDescMessage("custom.Input", {
      fields: [{ name: "query", type: "string" }],
    });
    const output = createMockDescMessage("custom.Output", {
      fields: [{ name: "result", type: "string" }],
    });
    const method = createMockDescMethod("Search", { input, output });

    assert.strictEqual(method.input.typeName, "custom.Input");
    assert.strictEqual(method.output.typeName, "custom.Output");
  });

  it("auto-creates input/output from name if not provided", () => {
    const method = createMockDescMethod("CreateOrder");

    assert.strictEqual(method.input.typeName, "test.CreateOrderRequest");
    assert.strictEqual(method.output.typeName, "test.CreateOrderResponse");
  });

  it("useSensitiveRedaction sets debug_redact in proto options", () => {
    const method = createMockDescMethod("Login", {
      useSensitiveRedaction: true,
    });

    assert.strictEqual(
      (method as any).proto.options.debug_redact,
      true,
    );
  });

  it("no redaction by default", () => {
    const method = createMockDescMethod("Ping");

    assert.strictEqual((method as any).proto.options, undefined);
  });

  it("has correct structural defaults", () => {
    const method = createMockDescMethod("Test") as any;

    assert.strictEqual(method.kind, "rpc");
    assert.strictEqual(method.deprecated, false);
    assert.strictEqual(method.parent, undefined);
  });
});

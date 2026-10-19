import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  createMockDescField,
  createMockDescMessage,
  createMockDescMethod,
} from "../../src/mock-desc.ts";
import {
  MAX_FIELD_NUMBER,
  REAL_METHODS,
  realMessage,
  realMethod,
  SCALAR_FIELD_TYPES,
} from "./support/real-protobuf.ts";

// Expected values come from descriptors compiled by the real @bufbuild/protobuf
// registry (tests/unit/support/real-protobuf.ts) and from the protobuf language
// guide (https://protobuf.dev/programming-guides/proto3/): field numbers are
// unique within a message and lie between 1 and 536,870,911.

const USER = "acme.v1.User";

// ============================================================
// createMockDescMessage
// ============================================================

describe("createMockDescMessage", () => {
  it("creates message with correct typeName and name", () => {
    const msg = createMockDescMessage("acme.v1.User");

    assert.strictEqual(msg.typeName, "acme.v1.User");
    assert.strictEqual(msg.name, "User");
  });

  // create() walks `desc.members`; a descriptor without an iterable `members`
  // makes it throw "desc.members is not iterable". The check therefore calls
  // create() on every shape of mock message instead of looking at the property.
  it("has members: [] (critical for @bufbuild/protobuf create())", () => {
    assert.strictEqual(create(realMessage(USER)).$typeName, USER, "reference: create() accepts a real descriptor");

    const shapes = [
      createMockDescMessage("test.Msg"),
      createMockDescMessage("test.WithFields", {
        fields: [{ name: "a", type: "int32" }, { name: "b" }],
      }),
      createMockDescMessage("test.WithOneof", { oneofs: ["credentials"] }),
    ];

    for (const desc of shapes) {
      assert.ok(Array.isArray((desc as any).members), `${desc.typeName}: members must be an array`);
      assert.strictEqual(create(desc).$typeName, desc.typeName);
    }
  });

  // DescMessage.members is documented as "Standalone fields and oneof groups for
  // this message, ordered by their appearance in the protobuf source".
  it(
    "members lists standalone fields and oneof groups like a real descriptor",
    () => {
      const realFields = realMessage(USER).fields.slice(0, 3);
      const mock = createMockDescMessage(USER, {
        fields: [{ name: "id", type: "int32" }, { name: "email" }, { name: "userName" }],
      });
      assert.deepStrictEqual(
        mock.members.map((m) => m.localName),
        realFields.map((f) => f.localName),
      );

      const withOneof = createMockDescMessage("acme.v1.Login", { oneofs: ["credentials"] });
      assert.deepStrictEqual(
        withOneof.members.map((m) => m.localName),
        realMessage("acme.v1.Login").members.map((m) => m.localName),
      );
    },
  );

  it(
    "create() zero-initialises the declared fields like it does for a real descriptor",
    () => {
      const mock = create(createMockDescMessage(USER, { fields: [{ name: "id", type: "int32" }, { name: "email" }] }));
      const real = create(realMessage(USER));

      assert.strictEqual((mock as any).id, (real as any).id);
      assert.strictEqual((mock as any).email, (real as any).email);
    },
  );

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

  it("field order, numbers and scalar types match the real descriptor for every scalar type", () => {
    const real = realMessage("acme.v1.Scalars");

    const msg = createMockDescMessage("acme.v1.Scalars", {
      fields: SCALAR_FIELD_TYPES.map(([name]) => ({ name, type: name })),
    });

    assert.strictEqual(msg.fields.length, real.fields.length);
    msg.fields.forEach((f, i) => {
      const expected = real.fields[i]!;
      assert.strictEqual(f.localName, expected.localName, `field ${i}: localName`);
      assert.strictEqual(f.number, expected.number, `field ${i}: number`);
      assert.strictEqual((f as any).scalar, expected.scalar, `${expected.name}: scalar`);
    });
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

  // DescMessage.field is "All fields of this message by their localName"; the
  // real registry stores the very same objects that are listed in `fields`.
  it("field map holds the same DescField objects as fields, keyed like the real descriptor", () => {
    const real = realMessage(USER);
    const names = ["id", "email", "userName"];

    const msg = createMockDescMessage(USER, { fields: names.map((name) => ({ name })) });

    assert.deepStrictEqual(Object.keys(msg.field), real.fields.slice(0, 3).map((f) => f.localName));
    assert.strictEqual(real.field.email, real.fields[1], "reference: field map holds the listed objects");
    msg.fields.forEach((f) => {
      assert.strictEqual(msg.field[f.localName], f, `${f.localName}: field map entry must be the listed object`);
    });
  });

  it(
    "field map is keyed by the camelCase localName of a snake_case field name",
    () => {
      const real = realMessage("acme.v1.Snake");

      const msg = createMockDescMessage("acme.v1.Snake", { fields: [{ name: "user_id" }] });

      assert.deepStrictEqual(Object.keys(msg.field), Object.keys(real.field));
    },
  );

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

  // In a real descriptor oneof.fields and field.oneof are two views of the same
  // membership: every field listed in a oneof points back at that oneof. The
  // factory cannot declare membership, so a mock oneof must not claim any field.
  it("oneofs keep their order and never claim fields that do not point back at them", () => {
    const real = realMessage("acme.v1.Login");
    const [realOneof] = real.oneofs;
    assert.ok(realOneof);
    assert.ok(realOneof.fields.every((f) => f.oneof === realOneof), "reference: membership is symmetric");

    const msg = createMockDescMessage("acme.v1.Login", {
      fields: [{ name: "password" }, { name: "token" }],
      oneofs: ["credentials", "other"],
    });

    assert.deepStrictEqual(
      msg.oneofs.map((o) => [o.kind, o.name, o.localName]),
      [
        [realOneof.kind, realOneof.name, realOneof.localName],
        ["oneof", "other", "other"],
      ],
    );
    for (const oneof of msg.oneofs) {
      assert.ok(
        oneof.fields.every((f) => f.oneof === oneof),
        `${oneof.name}: every listed field must point back at the oneof`,
      );
    }
    assert.deepStrictEqual(Object.keys(msg.field), ["password", "token"], "oneof names must not leak into the field map");
    assert.strictEqual(msg.fields.length, 2);
  });

  it("auto-increments fieldNumber when not specified", () => {
    const msg = createMockDescMessage("test.AutoNum", {
      fields: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });

    assert.strictEqual(msg.fields[0]!.number, 1);
    assert.strictEqual(msg.fields[1]!.number, 2);
    assert.strictEqual(msg.fields[2]!.number, 3);
  });

  it("automatic field numbers are unique and positive however many fields there are", () => {
    const msg = createMockDescMessage("test.ManyAuto", {
      fields: ["a", "b", "c", "d", "e", "f"].map((name) => ({ name })),
    });

    const numbers = msg.fields.map((f) => f.number);
    assert.strictEqual(new Set(numbers).size, numbers.length, `duplicate numbers in ${numbers.join(",")}`);
    assert.ok(numbers.every((n) => n >= 1), "field numbers start at 1");
  });

  it(
    "an explicit field number never collides with an automatic one",
    () => {
      const msg = createMockDescMessage("test.Mixed", {
        fields: [{ name: "a", fieldNumber: 2 }, { name: "b" }],
      });

      const numbers = msg.fields.map((f) => f.number);
      assert.strictEqual(new Set(numbers).size, numbers.length);
    },
  );

  it("an automatic number continues from the highest number used so far", () => {
    const msg = createMockDescMessage("test.Continue", {
      fields: [{ name: "a", fieldNumber: 10 }, { name: "b" }, { name: "c", fieldNumber: 3 }, { name: "d" }],
    });

    assert.deepStrictEqual(
      msg.fields.map((f) => f.number),
      [10, 11, 3, 12],
    );
  });

  // protoc rejects a message in which two fields share a number.
  it("throws when two fields carry the same explicit number", () => {
    assert.throws(
      () => createMockDescMessage("test.Dup", { fields: [{ name: "a", fieldNumber: 4 }, { name: "b", fieldNumber: 4 }] }),
      /field number 4/,
    );
  });

  it("throws when an explicit number repeats a number that was assigned automatically", () => {
    assert.throws(
      () => createMockDescMessage("test.DupAuto", { fields: [{ name: "a" }, { name: "b", fieldNumber: 1 }] }),
      /field number 1/,
    );
  });

  it("field name is the proto name; localName and jsonName follow the real descriptor rules", () => {
    const real = realMessage("acme.v1.Snake").fields[0]!;

    const field = createMockDescField("user_id");

    assert.strictEqual(field.name, real.name);
    assert.strictEqual(field.localName, real.localName);
    assert.strictEqual(field.jsonName, real.jsonName);
  });

  it("a camelCase field name keeps name, localName and jsonName unchanged", () => {
    const real = realMessage(USER).fields[2]!;

    const field = createMockDescField("userName");

    assert.deepStrictEqual([field.name, field.localName, field.jsonName], [real.name, real.localName, real.jsonName]);
  });

  it("field names that collide with built-in object properties get a $ suffix in localName only", () => {
    const real = realMessage("acme.v1.Reserved");

    const msg = createMockDescMessage("acme.v1.Reserved", {
      fields: real.fields.map((f) => ({ name: f.name })),
    });

    assert.deepStrictEqual(
      msg.fields.map((f) => [f.name, f.localName, f.jsonName]),
      real.fields.map((f) => [f.name, f.localName, f.jsonName]),
    );
    assert.deepStrictEqual(Object.keys(msg.field), Object.keys(real.field));
  });

  it("a field reports implicit presence and no declared default, like a proto3 field", () => {
    const real = realMessage(USER).fields[0]!;
    const field = createMockDescField("id", { type: "int32" });
    assert.ok(real.fieldKind === "scalar" && field.fieldKind === "scalar", "both fields are singular scalars");

    assert.strictEqual(field.presence, real.presence);
    assert.strictEqual(field.longAsString, real.longAsString);
    assert.strictEqual(field.getDefaultValue(), real.getDefaultValue());
  });

  it("create() zero-initialises every scalar type like the real descriptor", () => {
    const real = create(realMessage("acme.v1.Scalars"));

    const mock = create(
      createMockDescMessage("acme.v1.Scalars", {
        fields: SCALAR_FIELD_TYPES.map(([name]) => ({ name, type: name })),
      }),
    );

    assert.deepStrictEqual({ ...mock }, { ...real, $typeName: "acme.v1.Scalars" });
  });

  it("create() keeps the values passed in and zeroes the rest, keyed by localName", () => {
    const mock = createMockDescMessage("acme.v1.Snake", { fields: [{ name: "user_id" }, { name: "age", type: "int32" }] });

    const message = create(mock, { userId: "u-1" } as never) as unknown as Record<string, unknown>;

    assert.strictEqual(message.userId, "u-1");
    assert.strictEqual(message.age, 0);
  });

  it("create() initialises a oneof group as an unset case, like the real descriptor", () => {
    const real = create(realMessage("acme.v1.Login")) as unknown as Record<string, unknown>;

    const mock = create(createMockDescMessage("acme.v1.Login", { oneofs: ["credentials"] })) as unknown as Record<string, unknown>;

    assert.deepStrictEqual(real.credentials, { case: undefined });
    assert.deepStrictEqual(mock.credentials, real.credentials);
  });

  it("a oneof group name is turned into the localName of a real oneof group", () => {
    const real = realMessage("acme.v1.SnakeOneof");

    const msg = createMockDescMessage("acme.v1.SnakeOneof", { oneofs: ["login_method"] });

    assert.strictEqual(msg.oneofs[0]!.name, real.oneofs[0]!.name);
    assert.strictEqual(msg.oneofs[0]!.localName, real.oneofs[0]!.localName);
    assert.deepStrictEqual(Object.keys(create(msg)).sort(), Object.keys(create(real)).filter((k) => k !== "apiKey").sort());
  });

  it("members lists standalone fields in declaration order followed by the oneof groups", () => {
    const msg = createMockDescMessage("test.Order", { fields: [{ name: "b" }, { name: "a" }], oneofs: ["choice"] });

    assert.deepStrictEqual(
      msg.members.map((m) => m.localName),
      ["b", "a", "choice"],
    );
    assert.strictEqual(msg.members[2], msg.oneofs[0], "the oneof in members is the same object as in oneofs");
  });

  it("uses explicit fieldNumber when specified", () => {
    const msg = createMockDescMessage("test.ExplicitNum", {
      fields: [{ name: "x", fieldNumber: 10 }],
    });

    assert.strictEqual(msg.fields[0]!.number, 10);
  });

  it("explicit fieldNumber is kept across the whole valid range", () => {
    const real = realMessage(USER);
    assert.strictEqual(real.fields.at(-1)!.number, MAX_FIELD_NUMBER, "reference: the largest valid number is declared");

    const msg = createMockDescMessage(USER, {
      fields: real.fields.map((f) => ({ name: f.name, fieldNumber: f.number })),
    });

    assert.deepStrictEqual(
      msg.fields.map((f) => f.number),
      real.fields.map((f) => f.number),
    );
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

  // A field declared as `userName` has the same name, localName and jsonName in a
  // real descriptor; the mixed-case input keeps a lower-casing or re-casing
  // of jsonName from going unnoticed.
  it("name, localName and jsonName match the real descriptor for every field of a message", () => {
    for (const real of realMessage(USER).fields) {
      const field = createMockDescField(real.localName) as any;

      assert.strictEqual(field.localName, real.localName);
      assert.strictEqual(field.name, real.name, `${real.name}: name`);
      assert.strictEqual(field.jsonName, real.jsonName, `${real.name}: jsonName`);
    }
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

  it("custom fieldNumber is kept across the whole valid range", () => {
    for (const real of realMessage(USER).fields) {
      const field = createMockDescField(real.localName, { fieldNumber: real.number });

      assert.strictEqual(field.number, real.number, `${real.name}: number`);
    }
  });

  it("isSensitive sets debug_redact in proto options", () => {
    const field = createMockDescField("password", { isSensitive: true });

    assert.strictEqual((field as any).proto.options.debug_redact, true);
  });

  // A real field without annotations has no options message at all.
  it("non-sensitive field has undefined proto options", () => {
    const real = realMessage(USER).fields[0]!;
    assert.strictEqual(real.proto.options, undefined, "reference: unannotated real field has no options");

    for (const opts of [undefined, {}, { isSensitive: false }]) {
      const field = createMockDescField("username", opts);

      assert.strictEqual((field as any).proto.options, real.proto.options);
    }
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
  for (const { name } of REAL_METHODS) {
    it(`creates method with correct name: ${name}`, () => {
      const real = realMethod(name);

      const method = createMockDescMethod(real.name);

      assert.strictEqual(method.name, real.name);
      assert.strictEqual(method.kind, real.kind);
    });
  }

  // protobuf-es lowers only the first character of an RPC name (`URLFetch` ->
  // `uRLFetch`) and leaves a name that already starts in lower case unchanged.
  for (const { name } of REAL_METHODS.filter((m) => m.name !== "ToString")) {
    it(`localName is camelCase (first char lowered): ${name}`, () => {
      const method = createMockDescMethod(name);

      assert.strictEqual((method as any).localName, realMethod(name).localName);
    });
  }

  it(
    "localName escapes names that collide with built-in object properties",
    () => {
      const method = createMockDescMethod("ToString");

      assert.strictEqual(method.localName, realMethod("ToString").localName);
    },
  );

  it("default methodKind is unary", () => {
    const method = createMockDescMethod("Ping");

    assert.strictEqual(method.methodKind, "unary");
  });

  for (const kind of ["unary", "server_streaming", "client_streaming", "bidi_streaming"] as const) {
    it(`custom methodKind is set: ${kind}`, () => {
      const real = REAL_METHODS.find((m) => m.kind === kind);
      assert.ok(real, `no reference RPC of kind ${kind}`);

      const method = createMockDescMethod(real.name, { kind });

      assert.strictEqual(method.methodKind, realMethod(real.name).methodKind);
    });
  }

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

  // A real method points at the very descriptor objects of its message types, and
  // each side is independent of the other.
  it("custom input/output are the supplied descriptors, and each default applies independently", () => {
    const input = createMockDescMessage("custom.Input");
    const output = createMockDescMessage("custom.Output");

    const both = createMockDescMethod("Search", { input, output });
    assert.strictEqual(both.input, input);
    assert.strictEqual(both.output, output);

    const onlyInput = createMockDescMethod("Search", { input });
    assert.strictEqual(onlyInput.input, input);
    assert.strictEqual(onlyInput.output.typeName, "test.SearchResponse");

    const onlyOutput = createMockDescMethod("Search", { output });
    assert.strictEqual(onlyOutput.input.typeName, "test.SearchRequest");
    assert.strictEqual(onlyOutput.output, output);
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

  // A real method without annotations has no options message at all.
  it("no redaction by default", () => {
    const real = realMethod("GetUser");
    assert.strictEqual(real.proto.options, undefined, "reference: unannotated real method has no options");

    for (const opts of [undefined, {}, { useSensitiveRedaction: false }]) {
      const method = createMockDescMethod("Ping", opts);

      assert.strictEqual((method as any).proto.options, real.proto.options);
    }
  });

  it("has correct structural defaults", () => {
    const method = createMockDescMethod("Test") as any;

    assert.strictEqual(method.kind, "rpc");
    assert.strictEqual(method.deprecated, false);
    assert.strictEqual(method.parent, undefined);
  });
});

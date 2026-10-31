/**
 * Fallback handler results: a ready message, a message of another type and a plain object, per position.
 *
 * Wherever a field takes a plain initialiser, protobuf-es also accepts a ready message. For most message
 * fields that is harmless: a ready message of the field's type is used as it is. For the two types that
 * have a special form in a field it is not. A wrapper (`StringValue`) is a bare scalar there and a `Struct`
 * is a JSON object, so a ready message in their place is encoded as an object with the keys `value`,
 * `$typeName` or `fields`, which is another response. Each position is tried with
 *   (a) a ready message of the field's type,
 *   (b) a ready message of another type,
 *   (c1) a plain object whose `$typeName` names the field's type,
 *   (c2) a plain object whose `$typeName` names another type,
 *   (d) a plain object without `$typeName`.
 * A form is expected to pass iff the encoder writes it back unchanged (computed here with `create()`,
 * `toBinary()` and `fromBinary()`), except for a Struct, where the round trip cannot tell: a Struct message
 * comes back as the same JSON object, with the wrong keys. For it the decoded object is compared with the
 * JSON the handler meant.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescFile, DescMessage } from "@bufbuild/protobuf";
import { create, createFileRegistry, fromBinary, isMessage, toBinary } from "@bufbuild/protobuf";
import {
    FileDescriptorProtoSchema,
    file_google_protobuf_struct,
    file_google_protobuf_wrappers,
    FieldDescriptorProto_Label as Label,
    ListValueSchema,
    StringValueSchema,
    StructSchema,
    FieldDescriptorProto_Type as Type,
    ValueSchema,
} from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { createMockNextError, createMockRequest } from "@connectum/test-fixtures";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const field = (name: string, number: number, type: Type, extra: object = {}) => ({ name, number, type, label: Label.OPTIONAL, jsonName: name, ...extra });
const message = (name: string, number: number, typeName: string, extra: object = {}) => field(name, number, Type.MESSAGE, { typeName, ...extra });
const wellKnown: Record<string, DescFile> = {
    "google/protobuf/wrappers.proto": file_google_protobuf_wrappers,
    "google/protobuf/struct.proto": file_google_protobuf_struct,
};
const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
        name: "forms/v1/forms.proto",
        package: "forms.v1",
        syntax: "proto3",
        dependency: Object.keys(wellKnown),
        messageType: [
            { name: "Inner", field: [field("x", 1, Type.INT32)] },
            { name: "Other", field: [field("y", 1, Type.INT32)] },
            {
                name: "Holder",
                field: [
                    message("sv", 1, ".google.protobuf.StringValue"),
                    message("st", 2, ".google.protobuf.Struct"),
                    message("va", 3, ".google.protobuf.Value"),
                    message("lv", 4, ".google.protobuf.ListValue"),
                    message("inner", 5, ".forms.v1.Inner"),
                    message("inners", 6, ".forms.v1.Inner", { label: Label.REPEATED }),
                    message("mi", 7, ".forms.v1.Holder.MiEntry", { label: Label.REPEATED }),
                    message("svs", 8, ".google.protobuf.StringValue", { label: Label.REPEATED }),
                    message("sts", 9, ".google.protobuf.Struct", { label: Label.REPEATED }),
                ],
                nestedType: [{ name: "MiEntry", field: [field("key", 1, Type.STRING), message("value", 2, ".forms.v1.Inner")], options: { mapEntry: true } }],
            },
        ],
    }),
    (name) => wellKnown[name],
);
const Holder = registry.getMessage("forms.v1.Holder") as DescMessage;
const Inner = registry.getMessage("forms.v1.Inner") as DescMessage;
const Other = registry.getMessage("forms.v1.Other") as DescMessage;

const inner = create(Inner, { x: 1 });
const other = create(Other, { y: 1 });
const stringValue = create(StringValueSchema, { value: "s" });
const struct = create(StructSchema, { fields: { a: { kind: { case: "numberValue", value: 1 } } } } as never);
const value = create(ValueSchema, { kind: { case: "stringValue", value: "s" } });
const listValue = create(ListValueSchema, { values: [] });
assert.ok(isMessage(inner, Inner) && !isMessage(other, Inner), "the fixtures are what the table says they are");

/** The message the fallback interceptor answers with; rejects with its TypeError when it refuses the value. */
async function answer(init: unknown): Promise<unknown> {
    const request = createMockRequest();
    request.method.output = Holder;
    return (await createFallbackInterceptor({ handler: () => init })(createMockNextError(Code.Internal, "down") as never)(request)).message;
}

/** Whether the fallback interceptor lets the initialiser through (true) or refuses it with a TypeError (false). */
async function accepted(init: unknown): Promise<boolean> {
    try {
        await answer(init);
        return true;
    } catch (err) {
        assert.ok(err instanceof TypeError, `a refusal must be a TypeError, got ${String(err)}`);
        return false;
    }
}

/** The initialiser through `create()`, `toBinary()` and `fromBinary()`; `undefined` when the encoder throws. */
function decoded(init: unknown): Record<string, unknown> | undefined {
    try {
        return fromBinary(Holder, toBinary(Holder, create(Holder, init as never))) as unknown as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

describe("fallback handler: ready messages and plain objects in positions that take a message", () => {
    // Positions where a ready message of the field's type is used as it is and a plain object is its initialiser.
    const ordinary: Array<[string, (form: unknown) => unknown, { a: unknown; c1: unknown }]> = [
        ["a Value field", (form) => ({ va: form }), { a: value, c1: { $typeName: "google.protobuf.Value", kind: { case: "stringValue", value: "s" } } }],
        ["a ListValue field", (form) => ({ lv: form }), { a: listValue, c1: { $typeName: "google.protobuf.ListValue", values: [] } }],
        ["a message field", (form) => ({ inner: form }), { a: inner, c1: { $typeName: "forms.v1.Inner", x: 1 } }],
        ["an item of a repeated message field", (form) => ({ inners: [form] }), { a: inner, c1: { $typeName: "forms.v1.Inner", x: 1 } }],
        ["a value of a map<string, message>", (form) => ({ mi: { k: form } }), { a: inner, c1: { $typeName: "forms.v1.Inner", x: 1 } }],
        ["an item of a repeated StringValue field", (form) => ({ svs: [form] }), { a: stringValue, c1: { $typeName: "google.protobuf.StringValue", value: "s" } }],
    ];
    for (const [position, place, forms] of ordinary) {
        it(`${position}: (a) and (c1) pass, and the encoder agrees`, async () => {
            for (const form of [forms.a, forms.c1]) {
                assert.strictEqual(await accepted(place(form)), true);
                assert.ok(decoded(place(form)), "the encoder writes it");
            }
        });
        it(`${position}: (b) a message of another type and (c2) a plain object with a foreign $typeName are refused`, async () => {
            for (const form of [other, { $typeName: "x.Foreign", x: 1 }]) {
                assert.strictEqual(await accepted(place(form)), false);
            }
        });
        it(`${position}: (d) a plain object without $typeName passes`, async () => {
            const plain = { va: { kind: { case: "stringValue", value: "s" } }, lv: { values: [] }, inner: { x: 1 }, inners: { x: 1 }, mi: { x: 1 }, svs: { value: "s" } };
            const key = Object.keys(place("probe") as object)[0] as keyof typeof plain;
            assert.strictEqual(await accepted(place(plain[key])), true);
        });
    }

    it("a ready message of the field's type is written back unchanged in every ordinary position", () => {
        for (const [, place, forms] of ordinary) {
            const back = decoded(place(forms.a));
            assert.ok(back);
            const created = create(Holder, place(forms.a) as never);
            assert.deepStrictEqual(JSON.parse(JSON.stringify(back, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))), JSON.parse(JSON.stringify(created, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))));
        }
    });

    describe("a StringValue field, whose form is the bare string", () => {
        const intended = "s";
        const forms: Array<[string, unknown, boolean]> = [
            ["the bare string", intended, true],
            ["(a) a ready StringValue message", stringValue, false],
            ["(b) a message of another type", other, false],
            ["(c1) a plain object with the StringValue $typeName", { $typeName: "google.protobuf.StringValue", value: "s" }, false],
            ["(c2) a plain object with a foreign $typeName", { $typeName: "x.Foreign", value: "s" }, false],
            ["(d) a plain object { value }", { value: "s" }, false],
        ];
        for (const [label, form, expected] of forms) {
            it(`${label}: ${expected ? "passes" : "is refused"}, and the encoder ${expected ? "keeps" : "would change"} the string`, async () => {
                assert.strictEqual(await accepted({ sv: form }), expected);
                assert.strictEqual(decoded({ sv: form })?.sv === intended, expected);
            });
        }
    });

    describe("a Struct field, whose form is a JSON object", () => {
        const intended = { a: 1 };
        const forms: Array<[string, unknown, boolean]> = [
            ["a plain JSON object", { a: 1 }, true],
            ["(a) a ready Struct message", struct, false],
            ["(c1) a plain object with the Struct $typeName", { $typeName: "google.protobuf.Struct", fields: {} }, false],
            ["(c2) a plain object with a foreign $typeName", { $typeName: "x.Foreign", a: 1 }, true],
            ["(b) a message of another type, which is a JSON object with a foreign $typeName", other, true],
        ];
        for (const [label, form, expected] of forms) {
            it(`${label}: ${expected ? "passes" : "is refused"}`, async () => {
                assert.strictEqual(await accepted({ st: form }), expected);
                assert.strictEqual(await accepted({ sts: [form] }), expected);
            });
        }

        it("a refused Struct message would be written as a JSON object with the keys $typeName and fields", () => {
            const back = decoded({ st: struct })?.st as Record<string, unknown>;
            assert.notDeepStrictEqual(back, intended);
            assert.deepStrictEqual(Object.keys(back).sort(), ["$typeName", "fields"]);
        });

        it("names the Struct field and says a Struct message is not accepted", async () => {
            await assert.rejects(
                () => answer({ st: struct }),
                (err: unknown) => err instanceof TypeError && /st \(google\.protobuf\.Struct\) must be a plain JSON object, not a Struct message/.test(err.message),
            );
        });

        it("a Struct message inside a Value is an ordinary message and passes", async () => {
            assert.strictEqual(await accepted({ va: { kind: { case: "structValue", value: struct } } }), true);
        });
    });
});

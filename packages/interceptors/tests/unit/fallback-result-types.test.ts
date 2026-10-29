/**
 * Which plain objects a fallback handler may return, field kind by field kind.
 *
 * `create()` accepts far more than the response type allows: it coerces a number in a string
 * field to `"5"`, any truthy value in a bool field to `true`, drops a non-array in a repeated
 * field and drops the key of a oneof member. For a fallback each of those is a wrong response
 * with no signal, so the interceptor refuses them and names the offending path. Oracle: the
 * types `MessageInitShape` gives each field kind. The schema is built at run time so that every
 * field kind is present.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create, createFileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FieldDescriptorProto_Label as Label, FieldDescriptorProto_Type as Type } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { createMockNextError, createMockRequest } from "@connectum/test-fixtures";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const field = (name: string, number: number, type: Type, extra: object = {}) => ({ name, number, type, label: Label.OPTIONAL, jsonName: name, ...extra });
const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
        name: "kinds/v1/kinds.proto",
        package: "kinds.v1",
        syntax: "proto3",
        enumType: [
            {
                name: "Color",
                value: [
                    { name: "C_UNSPECIFIED", number: 0 },
                    { name: "C_RED", number: 1 },
                ],
            },
        ],
        messageType: [
            { name: "Inner", field: [field("x", 1, Type.INT32)] },
            {
                name: "Kinds",
                field: [
                    field("s", 1, Type.STRING),
                    field("b", 2, Type.BOOL),
                    field("i", 3, Type.INT32),
                    field("e", 4, Type.ENUM, { typeName: ".kinds.v1.Color" }),
                    field("m", 5, Type.MESSAGE, { typeName: ".kinds.v1.Inner" }),
                    field("r", 6, Type.INT32, { label: Label.REPEATED }),
                    field("a", 7, Type.STRING, { oneofIndex: 0 }),
                    field("c", 8, Type.INT32, { oneofIndex: 0 }),
                    field("big", 9, Type.INT64),
                    field("data", 10, Type.BYTES),
                    field("tags", 11, Type.MESSAGE, { label: Label.REPEATED, typeName: ".kinds.v1.Kinds.TagsEntry" }),
                    field("ms", 12, Type.MESSAGE, { label: Label.REPEATED, typeName: ".kinds.v1.Inner" }),
                ],
                nestedType: [{ name: "TagsEntry", field: [field("key", 1, Type.STRING), field("value", 2, Type.INT32)], options: { mapEntry: true } }],
                oneofDecl: [{ name: "pick" }],
            },
        ],
    }),
    () => undefined,
);
const Kinds = registry.getMessage("kinds.v1.Kinds");
assert.ok(Kinds);

/** A mock request whose method answers with the `Kinds` message. */
function request() {
    const req = createMockRequest();
    req.method.output = Kinds;
    return req;
}

/** The message the fallback interceptor answers with for a handler that returns `value`; rejects when it refuses the value. */
async function answer(value: unknown): Promise<unknown> {
    const result = await createFallbackInterceptor({ handler: () => value })(createMockNextError(Code.Internal, "down") as never)(request());
    return result.message;
}

describe("fallback handler: plain objects against every field kind", () => {
    const accepted: Array<[string, unknown]> = [
        ["empty object", {}],
        ["a string, a bool, an int32", { s: "a", b: true, i: 3 }],
        ["an enum number, including one the enum does not name", { e: 99 }],
        ["a nested plain object", { m: { x: 1 } }],
        ["a repeated field", { r: [1, 2] }],
        ["a oneof set as { case, value }", { pick: { case: "a", value: "z" } }],
        ["a oneof left unset", { pick: { case: undefined } }],
        ["an int64 as a bigint, a safe integer or a numeric string", { big: 5n }],
        ["bytes", { data: new Uint8Array([1]) }],
        ["undefined for a field", { s: undefined }],
        ["a map", { tags: { a: 1 } }],
        ["a list of nested plain objects", { ms: [{ x: 1 }] }],
    ];
    for (const [label, value] of accepted) {
        it(`accepts ${label}`, async () => {
            assert.ok(await answer(value));
        });
    }

    it("keeps the values it accepts", async () => {
        const message = (await answer({ s: "a", b: true, i: 3, m: { x: 1 }, r: [1, 2], pick: { case: "a", value: "z" }, big: 5n })) as Record<string, unknown>;

        assert.deepStrictEqual(
            { s: message.s, b: message.b, i: message.i, mx: (message.m as { x: number }).x, r: message.r, pick: message.pick, big: message.big },
            { s: "a", b: true, i: 3, mx: 1, r: [1, 2], pick: { case: "a", value: "z" }, big: 5n },
        );
    });

    const refused: Array<[string, unknown, RegExp]> = [
        ["a key the type does not have", { nope: 1 }, /nope is not a field of kinds\.v1\.Kinds/],
        ["a number in a string field", { s: 5 }, /s must be a well-formed string/],
        ["an object in a string field", { s: {} }, /s must be a well-formed string/],
        ["null in a string field", { s: null }, /s must be a well-formed string/],
        ["a string in a bool field", { b: "yes" }, /b must be a boolean/],
        ["1 in a bool field", { b: 1 }, /b must be a boolean/],
        ["a string in an int32 field", { i: "7" }, /i must be a number/],
        ["a fraction in an int32 field", { i: 1.5 }, /cannot be converted/],
        ["a number beyond int32", { i: 2 ** 40 }, /cannot be converted/],
        ["NaN in an int32 field", { i: Number.NaN }, /cannot be converted/],
        ["an enum name instead of its number", { e: "C_RED" }, /e must be an integer enum number/],
        ["a fraction in an enum field", { e: 1.5 }, /e must be an integer enum number/],
        ["a wrong value inside a nested object", { m: { x: "a" } }, /m\.x must be a number/],
        ["an unknown key inside a nested object", { m: { y: 1 } }, /m\.y is not a field of kinds\.v1\.Inner/],
        ["a number for a message field", { m: 5 }, /m must be a kinds\.v1\.Inner message or a plain object/],
        ["a number for a repeated field", { r: 5 }, /r must be an array/],
        ["a wrong item in a repeated field", { r: ["a"] }, /r\[0\] must be a number/],
        ["the key of a oneof member instead of the oneof", { a: "z" }, /a belongs to the oneof pick; set it as pick: \{ case: "a", value \}/],
        ["an unknown case of a oneof", { pick: { case: "nope", value: 1 } }, /pick\.case must be one of a, c/],
        ["a wrong value inside a oneof", { pick: { case: "c", value: "x" } }, /pick\.value must be a number/],
        ["a string that is no number for an int64", { big: "x" }, /big must be an integer inside the range of the type/],
        ["a fraction for an int64", { big: 1.5 }, /big must be an integer inside the range of the type, as a bigint, a safe integer or a canonical decimal string/],
        ["a string for bytes", { data: "abc" }, /data must be a Uint8Array/],
        ["a wrong value in a map", { tags: { a: "x" } }, /tags\["a"\] must be a number/],
        ["a non-object for a map", { tags: 5 }, /tags must be a plain object/],
        ["a wrong value in a list of nested objects", { ms: [{ x: "a" }] }, /ms\[0\]\.x must be a number/],
        ["an array instead of the object", [], /got object/],
        ["a string instead of the object", "text", /got string/],
        ["undefined instead of the object", undefined, /got undefined/],
        ["null instead of the object", null, /got null/],
    ];
    for (const [label, value, pattern] of refused) {
        it(`refuses ${label}, naming the problem`, async () => {
            await assert.rejects(
                () => answer(value),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /^createFallbackInterceptor: handler must return a kinds\.v1\.Kinds message or a plain object that initialises one/);
                    assert.match(err.message, pattern);
                    return true;
                },
            );
        });
    }
});

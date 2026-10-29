/**
 * Fallback handler results for the google.protobuf well-known types.
 *
 * protobuf-es gives some of them a special form inside a field, and `create()` reads that form:
 * a wrapper (StringValue, BytesValue, Int64Value, BoolValue) in a singular field outside a oneof
 * is its bare scalar, and a Struct outside google.protobuf.Value is a JSON object. The other
 * well-known types (Timestamp, Duration, Value, ListValue, Any, FieldMask, Empty) are ordinary
 * messages with ordinary initialisers, and a wrapper in a list or a oneof is an ordinary message
 * too. Oracle: the behaviour of `create()` plus `toBinary()` from @bufbuild/protobuf 2.16, run
 * for every case below; the accepted ones round-trip, the refused ones either throw there or
 * encode a wrong message without a signal (a `{ value }` object in a StringValue field).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescFile } from "@bufbuild/protobuf";
import { create, createFileRegistry, toBinary } from "@bufbuild/protobuf";
import {
    FileDescriptorProtoSchema,
    file_google_protobuf_any,
    file_google_protobuf_duration,
    file_google_protobuf_empty,
    file_google_protobuf_field_mask,
    file_google_protobuf_struct,
    file_google_protobuf_timestamp,
    file_google_protobuf_wrappers,
    FieldDescriptorProto_Label as Label,
    FieldDescriptorProto_Type as Type,
} from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { createMockNextError, createMockRequest } from "@connectum/test-fixtures";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const message = (name: string, number: number, typeName: string, extra: object = {}) => ({ name, number, type: Type.MESSAGE, label: Label.OPTIONAL, jsonName: name, typeName, ...extra });
const wellKnown: Record<string, DescFile> = {
    "google/protobuf/wrappers.proto": file_google_protobuf_wrappers,
    "google/protobuf/timestamp.proto": file_google_protobuf_timestamp,
    "google/protobuf/duration.proto": file_google_protobuf_duration,
    "google/protobuf/struct.proto": file_google_protobuf_struct,
    "google/protobuf/any.proto": file_google_protobuf_any,
    "google/protobuf/field_mask.proto": file_google_protobuf_field_mask,
    "google/protobuf/empty.proto": file_google_protobuf_empty,
};
const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
        name: "wk/v1/wk.proto",
        package: "wk.v1",
        syntax: "proto3",
        dependency: Object.keys(wellKnown),
        messageType: [
            {
                name: "Holder",
                field: [
                    message("str", 1, ".google.protobuf.StringValue"),
                    message("byt", 2, ".google.protobuf.BytesValue"),
                    message("i64", 3, ".google.protobuf.Int64Value"),
                    message("bl", 4, ".google.protobuf.BoolValue"),
                    message("ts", 5, ".google.protobuf.Timestamp"),
                    message("du", 6, ".google.protobuf.Duration"),
                    message("st", 7, ".google.protobuf.Struct"),
                    message("va", 8, ".google.protobuf.Value"),
                    message("lv", 9, ".google.protobuf.ListValue"),
                    message("an", 10, ".google.protobuf.Any"),
                    message("fm", 11, ".google.protobuf.FieldMask"),
                    message("em", 12, ".google.protobuf.Empty"),
                    message("strs", 13, ".google.protobuf.StringValue", { label: Label.REPEATED }),
                    message("sts", 14, ".google.protobuf.Struct", { label: Label.REPEATED }),
                    message("ow", 15, ".google.protobuf.StringValue", { oneofIndex: 0 }),
                    message("os", 16, ".google.protobuf.Struct", { oneofIndex: 0 }),
                ],
                oneofDecl: [{ name: "pick" }],
            },
        ],
    }),
    (name) => wellKnown[name],
);
const Holder = registry.getMessage("wk.v1.Holder");
assert.ok(Holder);

async function answer(value: unknown): Promise<Record<string, unknown>> {
    const request = createMockRequest();
    request.method.output = Holder;
    const result = await createFallbackInterceptor({ handler: () => value })(createMockNextError(Code.Internal, "down") as never)(request);
    return result.message as Record<string, unknown>;
}

describe("fallback handler: well-known types in a field", () => {
    const accepted: Array<[string, unknown]> = [
        ["a StringValue field as a bare string", { str: "cached" }],
        ["a BytesValue field as a Uint8Array", { byt: new Uint8Array([1]) }],
        ["a BytesValue field as an array of byte values", { byt: [1, 2] }],
        ["an Int64Value field as a bigint", { i64: 5n }],
        ["an Int64Value field as a safe integer", { i64: 5 }],
        ["a BoolValue field as a boolean", { bl: true }],
        ["a Timestamp as { seconds, nanos }", { ts: { seconds: 1n, nanos: 2 } }],
        ["a Duration as { seconds }", { du: { seconds: 1n } }],
        ["a Struct field as a nested JSON object", { st: { a: 1, b: [1, "x", null], c: { d: true } } }],
        ["a Struct field with an absent (undefined) key", { st: { a: undefined } }],
        ["a Value as { kind: { case, value } }", { va: { kind: { case: "stringValue", value: "x" } } }],
        ["a Value whose kind is a Struct message (an ordinary message inside Value)", { va: { kind: { case: "structValue", value: { fields: { a: { kind: { case: "numberValue", value: 1 } } } } } } }],
        ["a ListValue as { values }", { lv: { values: [{ kind: { case: "numberValue", value: 1 } }] } }],
        ["an Any as { typeUrl, value }", { an: { typeUrl: "type.example/T", value: new Uint8Array([1]) } }],
        ["a FieldMask as { paths }", { fm: { paths: ["a"] } }],
        ["an Empty as {}", { em: {} }],
        ["a list of wrappers as message objects", { strs: [{ value: "a" }] }],
        ["a list of Structs as JSON objects", { sts: [{ a: 1 }] }],
        ["a wrapper in a oneof as a message object", { pick: { case: "ow", value: { value: "x" } } }],
        ["a Struct in a oneof as a JSON object", { pick: { case: "os", value: { a: 1 } } }],
    ];
    for (const [label, value] of accepted) {
        it(`accepts ${label}, and the result encodes`, async () => {
            const result = await answer(value);
            toBinary(Holder, result as never);
        });
    }

    it("keeps the bare scalar of a wrapper and the JSON object of a Struct", async () => {
        const result = await answer({ str: "cached", st: { a: [1, { b: null }] } });

        assert.strictEqual(result.str, "cached");
        assert.deepStrictEqual(result.st, { a: [1, { b: null }] });
    });

    const refused: Array<[string, unknown, RegExp]> = [
        ["a message object in a StringValue field", { str: { value: "x" } }, /str \(google\.protobuf\.StringValue\) must be a well-formed string, not a message object/],
        ["a number in a StringValue field", { str: 5 }, /str \(google\.protobuf\.StringValue\) must be a well-formed string/],
        ["a message object in a BytesValue field", { byt: { value: new Uint8Array([1]) } }, /byt \(google\.protobuf\.BytesValue\) must be a Uint8Array/],
        ["a message object in an Int64Value field", { i64: { value: 5n } }, /i64 \(google\.protobuf\.Int64Value\) must be an integer inside the range of the type/],
        ["a message object in a BoolValue field", { bl: { value: true } }, /bl \(google\.protobuf\.BoolValue\) must be a boolean/],
        ["a Date for a Timestamp", { ts: new Date() }, /ts must be a google\.protobuf\.Timestamp message or a plain object/],
        ["an RFC 3339 string for a Timestamp", { ts: "2020-01-01T00:00:00Z" }, /ts must be a google\.protobuf\.Timestamp message or a plain object/],
        ["a duration string for a Duration", { du: "1s" }, /du must be a google\.protobuf\.Duration message or a plain object/],
        ["a bigint inside a Struct", { st: { a: 1n } }, /st\.a must be a JSON value/],
        ["an array for a Struct", { st: [1] }, /st \(google\.protobuf\.Struct\) must be a plain JSON object/],
        ["a string for a Struct", { st: "x" }, /st \(google\.protobuf\.Struct\) must be a plain JSON object/],
        ["a bare string for a Value", { va: "x" }, /va must be a google\.protobuf\.Value message or a plain object/],
        ["a bare array for a ListValue", { lv: [1, 2] }, /lv must be a google\.protobuf\.ListValue message or a plain object/],
        ["a comma string for a FieldMask", { fm: "a,b" }, /fm must be a google\.protobuf\.FieldMask message or a plain object/],
        ["a bare string in a list of wrappers", { strs: ["a"] }, /strs\[0\] must be a google\.protobuf\.StringValue message or a plain object/],
        ["a bare string for a wrapper in a oneof", { pick: { case: "ow", value: "x" } }, /pick\.value must be a google\.protobuf\.StringValue message or a plain object/],
    ];
    for (const [label, value, pattern] of refused) {
        it(`refuses ${label}`, async () => {
            await assert.rejects(
                () => answer(value),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, pattern);
                    return true;
                },
            );
        });
    }
});

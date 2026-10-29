/**
 * Fallback handler results: every position that holds a string or a key, and JSON inside a Struct.
 *
 * A string with a lone surrogate is written as U+FFFD, so the response would carry a different string or
 * key. That can happen wherever a string appears, so each position is listed here, once with a lone
 * surrogate and once with a string full of awkward but valid characters (an emoji, NUL, U+2028, a BOM).
 * The expected verdict is not written by hand: a value is expected to be accepted iff it comes back from
 * `create()`, `toBinary()` and `fromBinary()` unchanged, so the table is exact in both directions.
 * The JSON table does the same for values a Struct can hold.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescFile, DescMessage } from "@bufbuild/protobuf";
import { create, createFileRegistry, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import {
    FileDescriptorProtoSchema,
    file_google_protobuf_any,
    file_google_protobuf_field_mask,
    file_google_protobuf_struct,
    file_google_protobuf_wrappers,
    FieldDescriptorProto_Label as Label,
    FieldDescriptorProto_Type as Type,
} from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { createMockNextError, createMockRequest } from "@connectum/test-fixtures";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const field = (name: string, number: number, type: Type, extra: object = {}) => ({ name, number, type, label: Label.OPTIONAL, jsonName: name, ...extra });
const message = (name: string, number: number, typeName: string, extra: object = {}) => field(name, number, Type.MESSAGE, { typeName, ...extra });
const wellKnown: Record<string, DescFile> = {
    "google/protobuf/wrappers.proto": file_google_protobuf_wrappers,
    "google/protobuf/struct.proto": file_google_protobuf_struct,
    "google/protobuf/any.proto": file_google_protobuf_any,
    "google/protobuf/field_mask.proto": file_google_protobuf_field_mask,
};
const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
        name: "strings/v1/strings.proto",
        package: "strings.v1",
        syntax: "proto3",
        dependency: Object.keys(wellKnown),
        messageType: [
            { name: "Inner", field: [field("s", 1, Type.STRING)] },
            {
                name: "Holder",
                field: [
                    field("s", 1, Type.STRING),
                    field("rs", 2, Type.STRING, { label: Label.REPEATED }),
                    message("mss", 3, ".strings.v1.Holder.MssEntry", { label: Label.REPEATED }),
                    message("msm", 4, ".strings.v1.Holder.MsmEntry", { label: Label.REPEATED }),
                    field("o", 5, Type.STRING, { oneofIndex: 0 }),
                    message("inner", 6, ".strings.v1.Inner"),
                    message("inners", 7, ".strings.v1.Inner", { label: Label.REPEATED }),
                    message("st", 8, ".google.protobuf.Struct"),
                    message("sts", 9, ".google.protobuf.Struct", { label: Label.REPEATED }),
                    message("va", 10, ".google.protobuf.Value"),
                    message("lv", 11, ".google.protobuf.ListValue"),
                    message("an", 12, ".google.protobuf.Any"),
                    message("fm", 13, ".google.protobuf.FieldMask"),
                    message("sv", 14, ".google.protobuf.StringValue"),
                    message("svs", 15, ".google.protobuf.StringValue", { label: Label.REPEATED }),
                    message("mst", 16, ".strings.v1.Holder.MstEntry", { label: Label.REPEATED }),
                    message("ostr", 17, ".google.protobuf.Struct", { oneofIndex: 0 }),
                ],
                oneofDecl: [{ name: "pick" }],
                nestedType: [
                    { name: "MssEntry", field: [field("key", 1, Type.STRING), field("value", 2, Type.STRING)], options: { mapEntry: true } },
                    { name: "MsmEntry", field: [field("key", 1, Type.STRING), message("value", 2, ".strings.v1.Inner")], options: { mapEntry: true } },
                    { name: "MstEntry", field: [field("key", 1, Type.STRING), message("value", 2, ".google.protobuf.Struct")], options: { mapEntry: true } },
                ],
            },
        ],
    }),
    (name) => wellKnown[name],
);
const Holder = registry.getMessage("strings.v1.Holder") as DescMessage;

/** A string that tells apart what `JSON.stringify` would merge: -0 and 0, NaN and null, a hole and null, a Date and {}. */
const shape = (x: unknown): string => {
    if (x === null) return "null";
    if (typeof x === "number") return `n${Object.is(x, -0) ? "-0" : String(x)}`;
    if (typeof x === "string") return JSON.stringify(x);
    if (typeof x === "boolean") return String(x);
    if (typeof x === "bigint") return `${x}n`;
    if (x instanceof Uint8Array) return `bytes[${[...x].join(",")}]`;
    if (Array.isArray(x)) {
        return `[${Array.from({ length: x.length }, (_, index) => (index in x ? shape(x[index]) : "HOLE")).join(",")}]`;
    }
    if (typeof x === "object" && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null || "$typeName" in x)) {
        const record = x as Record<string, unknown>;
        return `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${shape(record[key])}`)
            .join(",")}}`;
    }
    return `X:${Object.prototype.toString.call(x)}`;
};

/**
 * True iff the response survives the binary round trip unchanged.
 */
function roundTripUnchanged(init: unknown): boolean {
    try {
        const created = create(Holder, init as never);
        const decoded = fromBinary(Holder, toBinary(Holder, created));
        return shape(created) === shape(decoded);
    } catch {
        return false;
    }
}

async function accepted(init: unknown): Promise<boolean> {
    const request = createMockRequest();
    request.method.output = Holder;
    try {
        await createFallbackInterceptor({ handler: () => init })(createMockNextError(Code.Internal, "down") as never)(request);
        return true;
    } catch (err) {
        assert.ok(err instanceof TypeError, `a refusal must be a TypeError, got ${String(err)}`);
        return false;
    }
}

const strings = { "a lone surrogate": "a\ud800b", "valid but awkward characters": "a😀\u0000 ﻿" };
const caseValue = (value: string) => ({ case: "stringValue", value });
const positions: Array<[string, (s: string) => unknown]> = [
    ["a string field", (s) => ({ s })],
    ["an item of a repeated string", (s) => ({ rs: [s] })],
    ["a key of map<string, string>", (s) => ({ mss: { [s]: "v" } })],
    ["a value of map<string, string>", (s) => ({ mss: { k: s } })],
    ["a key of map<string, message>", (s) => ({ msm: { [s]: {} } })],
    ["a string in a value of map<string, message>", (s) => ({ msm: { k: { s } } })],
    ["a string member of a oneof", (s) => ({ pick: { case: "o", value: s } })],
    ["a string in a nested message", (s) => ({ inner: { s } })],
    ["a string in a repeated message", (s) => ({ inners: [{ s }] })],
    ["a key of a Struct", (s) => ({ st: { [s]: 1 } })],
    ["a key of a Struct nested in a Struct", (s) => ({ st: { a: { [s]: 1 } } })],
    ["a key of a Struct inside an array in a Struct", (s) => ({ st: { a: [{ [s]: 1 }] } })],
    ["a string value of a Struct", (s) => ({ st: { a: s } })],
    ["a string in an array in a Struct", (s) => ({ st: { a: [s] } })],
    ["a key of a Struct in a repeated Struct field", (s) => ({ sts: [{ [s]: 1 }] })],
    ["a key of a Struct in a value of map<string, Struct>", (s) => ({ mst: { k: { [s]: 1 } } })],
    ["a key of map<string, Struct>", (s) => ({ mst: { [s]: {} } })],
    ["a key of a Struct in a oneof", (s) => ({ pick: { case: "ostr", value: { [s]: 1 } } })],
    ["the string of a Value", (s) => ({ va: { kind: caseValue(s) } })],
    ["a key in the fields of a Struct message inside a Value", (s) => ({ va: { kind: { case: "structValue", value: { fields: { [s]: { kind: { case: "nullValue", value: 0 } } } } } } })],
    ["a string nested in the Struct message of a Value", (s) => ({ va: { kind: { case: "structValue", value: { fields: { a: { kind: caseValue(s) } } } } } })],
    ["a string in a ListValue", (s) => ({ lv: { values: [{ kind: caseValue(s) }] } })],
    ["the type URL of an Any", (s) => ({ an: { typeUrl: s } })],
    ["a path of a FieldMask", (s) => ({ fm: { paths: [s] } })],
    ["a StringValue field", (s) => ({ sv: s })],
    ["a StringValue in a repeated field", (s) => ({ svs: [{ value: s }] })],
];

describe("fallback handler: a string or key is accepted exactly when the encoder writes it back unchanged", () => {
    for (const [position, make] of positions) {
        for (const [kind, text] of Object.entries(strings)) {
            it(`${position}: ${kind}`, async () => {
                const init = make(text);
                assert.strictEqual(await accepted(init), roundTripUnchanged(init));
            });
        }
    }

    it("refuses a lone surrogate in the key of a Struct, at any depth, naming the key", async () => {
        for (const init of [{ st: { "a\ud800b": 1 } }, { st: { a: { "a\ud800b": 1 } } }, { st: { a: [{ "a\ud800b": 1 }] } }]) {
            const request = createMockRequest();
            request.method.output = Holder;
            await assert.rejects(
                () => createFallbackInterceptor({ handler: () => init })(createMockNextError(Code.Internal, "down") as never)(request),
                (err: unknown) => err instanceof TypeError && /the key "a\\ud800b" of st(\.a)?(\[0\])? must be a well-formed string/.test(err.message),
            );
        }
    });

    it("still treats a key whose value is undefined as absent, even with a lone surrogate in it", async () => {
        assert.ok(await accepted({ st: { "a\ud800b": undefined, ok: 1 } }));
    });
});

describe("fallback handler: JSON inside a Struct is accepted exactly when it comes back unchanged", () => {
    const jsonValues: Array<[string, unknown]> = [
        ["null", null],
        ["true", true],
        ["zero", 0],
        ["negative zero", -0],
        ["a fraction", 1.5],
        ["a very large number", 1e300],
        ["a very small number", 5e-324],
        ["a number above 2**53", 2 ** 60],
        ["a bigint", 1n],
        ["an empty string", ""],
        ["an empty array", []],
        ["an empty object", {}],
        ["a nested array of arrays", [[1], [[2]]]],
        ["an array with null", [null, 1]],
        ["a sparse array", [1, , 3]],
        ["an object with an empty key", { "": 1 }],
        ["an object with a numeric-looking key", { "1": 1, "01": 2 }],
        ["a Date", new Date(0)],
        ["a function", () => 1],
        ["a symbol", Symbol("x")],
    ];
    for (const [label, value] of jsonValues) {
        it(`a Struct holding ${label}`, async () => {
            const init = { st: { v: value } };
            assert.strictEqual(await accepted(init), roundTripUnchanged(init));
        });
    }

    // The binary encoding writes NaN and Infinity into a Struct and reads them back, so the table above would
    // accept them. They are not JSON, and the JSON form of the same message (what a Connect client that asks
    // for JSON receives) cannot carry them, so they are refused on purpose.
    for (const [label, value] of [
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
    ] as const) {
        it(`a Struct holding ${label} is refused because the JSON form of the message cannot carry it`, async () => {
            const init = { st: { v: value } };
            assert.throws(() => toJson(Holder, create(Holder, init as never)), /cannot be NaN or Infinity|NaN|Infinity/);
            assert.strictEqual(await accepted(init), false);
        });
    }

    it("a Struct with an own __proto__ key", async () => {
        const init = { st: JSON.parse('{"__proto__": 1, "a": 2}') as Record<string, unknown> };
        assert.strictEqual(await accepted(init), roundTripUnchanged(init));
    });
});

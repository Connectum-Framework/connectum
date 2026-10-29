/**
 * Fallback handler results: map keys, 64-bit strings, bytes and strings, edge by edge.
 *
 * A key of a map is a string in a JS object, and the encoder parses it by the key type: `"01"` and
 * `" 1"` become 1, `""` becomes 0, `"abc"` for a bool becomes `true`. A response written from such a key
 * answers a different key than the one the handler named. The check must therefore accept exactly the keys
 * the encoder writes back unchanged. The first table derives that from @bufbuild/protobuf itself
 * (`create()`, `toBinary()`, `fromBinary()`): a key is expected to pass iff it comes back identical, so the
 * test stays exact in both directions without a hand-written list. The other tables pin the values around it.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create, createFileRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FieldDescriptorProto_Label as Label, FieldDescriptorProto_Type as Type } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { createMockNextError, createMockRequest } from "@connectum/test-fixtures";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const field = (name: string, number: number, type: Type, extra: object = {}) => ({ name, number, type, label: Label.OPTIONAL, jsonName: name, ...extra });
const keyTypes: Array<[string, Type]> = [
    ["string", Type.STRING],
    ["int32", Type.INT32],
    ["uint32", Type.UINT32],
    ["sint32", Type.SINT32],
    ["fixed32", Type.FIXED32],
    ["sfixed32", Type.SFIXED32],
    ["int64", Type.INT64],
    ["uint64", Type.UINT64],
    ["sint64", Type.SINT64],
    ["fixed64", Type.FIXED64],
    ["sfixed64", Type.SFIXED64],
    ["bool", Type.BOOL],
];
const entryName = (type: string) => `M${type[0]?.toUpperCase()}${type.slice(1)}Entry`;
const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
        name: "edges/v1/edges.proto",
        package: "edges.v1",
        syntax: "proto3",
        enumType: [
            {
                name: "Color",
                value: [
                    { name: "C0", number: 0 },
                    { name: "C1", number: 1 },
                ],
            },
        ],
        messageType: [
            { name: "Inner", field: [field("x", 1, Type.INT32)] },
            {
                name: "Edges",
                field: [
                    ...keyTypes.map(([name], index) => field(`m${name}`, index + 1, Type.MESSAGE, { label: Label.REPEATED, typeName: `.edges.v1.Edges.${entryName(name)}` })),
                    field("s", 20, Type.STRING),
                    field("i64", 21, Type.INT64),
                    field("u64", 22, Type.UINT64),
                    field("by", 23, Type.BYTES),
                    field("e", 24, Type.ENUM, { typeName: ".edges.v1.Color" }),
                    field("r", 25, Type.INT32, { label: Label.REPEATED }),
                    field("rb", 26, Type.BYTES, { label: Label.REPEATED }),
                    field("tree", 27, Type.MESSAGE, { label: Label.REPEATED, typeName: ".edges.v1.Edges.TreeEntry" }),
                    field("a", 28, Type.STRING, { oneofIndex: 0 }),
                    field("c", 29, Type.INT32, { oneofIndex: 0 }),
                    field("fl", 30, Type.FLOAT),
                    field("db", 31, Type.DOUBLE),
                ],
                oneofDecl: [{ name: "pick" }],
                nestedType: [
                    ...keyTypes.map(([name, type]) => ({ name: entryName(name), field: [field("key", 1, type), field("value", 2, Type.INT32)], options: { mapEntry: true } })),
                    { name: "TreeEntry", field: [field("key", 1, Type.STRING), field("value", 2, Type.MESSAGE, { typeName: ".edges.v1.Inner" })], options: { mapEntry: true } },
                ],
            },
        ],
    }),
    () => undefined,
);
const Edges = registry.getMessage("edges.v1.Edges");
assert.ok(Edges);

/** Runs the value through the fallback interceptor; resolves when it is accepted, rejects with the TypeError when it is not. */
async function answer(value: unknown): Promise<unknown> {
    const request = createMockRequest();
    request.method.output = Edges;
    return (await createFallbackInterceptor({ handler: () => value })(createMockNextError(Code.Internal, "down") as never)(request)).message;
}

async function accepted(value: unknown): Promise<boolean> {
    try {
        await answer(value);
        return true;
    } catch (err) {
        assert.ok(err instanceof TypeError, `a refusal must be a TypeError, got ${String(err)}`);
        return false;
    }
}

const keys = [
    "0", "1", "-1", "7", "2147483647", "-2147483648", "2147483648", "-2147483649", "4294967295", "4294967296",
    "9223372036854775807", "-9223372036854775808", "9223372036854775808", "18446744073709551615", "18446744073709551616", "-9223372036854775809",
    "01", "00", "-0", "+1", "1.5", "1e3", "0x10", " 1", "1 ", "", "abc", "NaN", "Infinity", "true", "false", "yes", "True", "1n", "٣", "a\ud800b", "a😀",
];

describe("fallback handler: map keys are accepted exactly when the encoder writes them back unchanged", () => {
    for (const [name] of keyTypes) {
        it(`map<${name}, int32>: the verdict for ${keys.length} keys equals the round trip of the encoder`, async () => {
            const mismatches: string[] = [];
            for (const key of keys) {
                let roundTripUnchanged: boolean;
                try {
                    const message = create(Edges, { [`m${name}`]: { [key]: 1 } } as never);
                    const back = fromBinary(Edges, toBinary(Edges, message)) as unknown as Record<string, Record<string, number>>;
                    const backKeys = Object.keys(back[`m${name}`] ?? {});
                    roundTripUnchanged = backKeys.length === 1 && backKeys[0] === key;
                } catch {
                    roundTripUnchanged = false;
                }
                // A string key that is not well formed comes back with U+FFFD, which the round trip above shows as a change.
                const verdict = await accepted({ [`m${name}`]: { [key]: 1 } });
                if (verdict !== roundTripUnchanged) {
                    mismatches.push(`${JSON.stringify(key)}: accepted=${verdict}, round trip unchanged=${roundTripUnchanged}`);
                }
            }
            assert.deepStrictEqual(mismatches, []);
        });
    }

    const refusedKeys: Array<[string, string, string]> = [
        ["int32", "01", "map keys with a leading zero"],
        ["int32", "+1", "map keys with a plus sign"],
        ["int32", "1.5", "a fraction as a key"],
        ["int32", "1e3", "an exponent as a key"],
        ["int32", "", "an empty key"],
        ["int32", " 1", "a key with a space"],
        ["int32", "-0", "negative zero as a key"],
        ["int32", "2147483648", "a key above the int32 range"],
        ["uint32", "-1", "a negative key for an unsigned type"],
        ["int64", "9223372036854775808", "a key above the int64 range"],
        ["uint64", "18446744073709551616", "a key above the uint64 range"],
        ["bool", "yes", "a bool key that is not true or false"],
        ["bool", "1", "1 as a bool key"],
        ["bool", "", "an empty bool key"],
    ];
    for (const [type, key, label] of refusedKeys) {
        it(`names the key and its map when it refuses ${label} (${type})`, async () => {
            await assert.rejects(
                () => answer({ [`m${type}`]: { [key]: 1 } }),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError);
                    assert.ok(err.message.includes(`the key ${JSON.stringify(key)} of m${type} must be `), err.message);
                    return true;
                },
            );
        });
    }

    it("accepts the keys at the edges of every integer range", async () => {
        assert.ok(
            await accepted({
                mint32: { "-2147483648": 1, "2147483647": 2 },
                muint32: { "0": 1, "4294967295": 2 },
                mint64: { "-9223372036854775808": 1, "9223372036854775807": 2 },
                muint64: { "0": 1, "18446744073709551615": 2 },
                mbool: { true: 1, false: 2 },
            }),
        );
    });

    it("checks the values of a map<string, message> and names the entry", async () => {
        assert.ok(await accepted({ tree: { a: { x: 1 }, b: {} } }));
        await assert.rejects(
            () => answer({ tree: { a: { x: "no" } } }),
            (err: unknown) => err instanceof TypeError && /tree\["a"\]\.x must be a number/.test(err.message),
        );
    });
});

describe("fallback handler: other edges of scalar values", () => {
    const acceptedValues: Array<[string, unknown]> = [
        ["a string with an emoji", { s: "a😀" }],
        ["-0 for an int32", { s: undefined, r: [-0] }],
        ["the int64 minimum and maximum as bigints", { i64: -(2n ** 63n) }],
        ["the int64 maximum", { i64: 2n ** 63n - 1n }],
        ["the uint64 maximum", { u64: 2n ** 64n - 1n }],
        ["a canonical decimal string for an int64", { i64: "-9223372036854775808" }],
        ["zero as a string for an int64", { i64: "0" }],
        ["NaN and Infinity for a float and a double", { fl: Number.NaN, db: Number.POSITIVE_INFINITY }],
        ["a Buffer for bytes", { by: Buffer.from([1, 2]) }],
        ["an array of byte values", { by: [0, 255] }],
        ["a list of byte arrays", { rb: [[1], new Uint8Array([2])] }],
        ["an enum number at the int32 edge", { e: -(2 ** 31) }],
        ["an enum number the enum does not name", { e: 99 }],
    ];
    for (const [label, value] of acceptedValues) {
        it(`accepts ${label}`, async () => {
            assert.ok(await accepted(value));
        });
    }

    const refusedValues: Array<[string, unknown, RegExp]> = [
        ["a lone surrogate in a string", { s: "a\ud800b" }, /s must be a well-formed string/],
        ["an int64 bigint above the range", { i64: 2n ** 63n }, /i64 must be an integer inside the range/],
        ["an int64 bigint below the range", { i64: -(2n ** 63n) - 1n }, /i64 must be an integer inside the range/],
        ["a negative bigint for a uint64", { u64: -1n }, /u64 must be an integer inside the range/],
        ["a uint64 bigint above the range", { u64: 2n ** 64n }, /u64 must be an integer inside the range/],
        ["a negative number for a uint64", { u64: -1 }, /u64 must be an integer inside the range/],
        ["an unsafe integer for an int64", { i64: 2 ** 53 }, /i64 must be an integer inside the range/],
        ["an empty string for an int64", { i64: "" }, /i64 must be an integer inside the range/],
        ["a string with a leading zero for an int64", { i64: "01" }, /i64 must be an integer inside the range/],
        ["a hexadecimal string for an int64", { i64: "0x10" }, /i64 must be an integer inside the range/],
        ["a string with a space for an int64", { i64: " 1" }, /i64 must be an integer inside the range/],
        ["negative zero as a string for an int64", { i64: "-0" }, /i64 must be an integer inside the range/],
        ["an out-of-range string for an int64", { i64: "9223372036854775808" }, /i64 must be an integer inside the range/],
        ["an ArrayBuffer for bytes", { by: new ArrayBuffer(2) }, /by must be a Uint8Array or an array of byte values/],
        ["a DataView for bytes", { by: new DataView(new ArrayBuffer(2)) }, /by must be a Uint8Array or an array of byte values/],
        ["a Uint16Array for bytes", { by: new Uint16Array([1, 258]) }, /by must be a Uint8Array or an array of byte values/],
        ["a sparse array for bytes", { by: [1, , 3] }, /by must be a Uint8Array or an array of byte values \(integers from 0 to 255, no holes\)/],
        ["256 in a byte array", { by: [256] }, /integers from 0 to 255/],
        ["1.5 in a byte array", { by: [1.5] }, /integers from 0 to 255/],
        ["-1 in a byte array", { by: [-1] }, /integers from 0 to 255/],
        ["a sparse byte array inside a list", { rb: [[1, , 3]] }, /rb\[0\] must be a Uint8Array or an array of byte values/],
        ["a sparse list", { r: [1, , 3] }, /r\[1\] must be a number/],
        ["undefined in a list", { r: [undefined] }, /r\[0\] must be a number/],
        ["null in a list", { r: [null] }, /r\[0\] must be a number/],
        ["an array-like object for a list", { r: { 0: 1, length: 1 } }, /r must be an array/],
        ["an enum number above the int32 range", { e: 2 ** 31 }, /cannot be converted/],
        ["an enum name", { e: "C1" }, /e must be an integer enum number/],
        ["a oneof object with an extra key", { pick: { case: "a", value: "x", c: 1 } }, /pick must be \{ case, value \} of the oneof/],
        ["both members of a oneof as bare keys", { a: "x", c: 1 }, /belongs to the oneof pick/],
        ["a number beyond float32", { fl: 1e40 }, /cannot be converted/],
    ];
    for (const [label, value, pattern] of refusedValues) {
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

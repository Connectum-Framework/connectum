/**
 * Check of a plain object that is to become a response message.
 *
 * `create()` is lenient: it drops keys the type does not have and coerces values of the
 * wrong type (a number in a string field becomes `"5"`, any truthy value in a bool field
 * becomes `true`, a non-array in a repeated field is dropped). For a fallback, whose value
 * answers a call that already failed, each of those would be a response that is wrong
 * without any signal. This check walks the object against the descriptor first and names
 * the first offending path.
 *
 * @module response-init
 */

import type { DescField, DescMessage } from "@bufbuild/protobuf";
import { isMessage, ScalarType } from "@bufbuild/protobuf";
import { isWrapperDesc } from "@bufbuild/protobuf/wkt";

/** Whether a value is a plain object: not null, not an array, not an instance of a class. A protobuf message is one too. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Inclusive range of the integer scalar types, which map keys and 64-bit string values are held to. */
function integerRange(scalar: ScalarType): readonly [bigint, bigint] | undefined {
    switch (scalar) {
        case ScalarType.INT32:
        case ScalarType.SINT32:
        case ScalarType.SFIXED32:
            return [-(2n ** 31n), 2n ** 31n - 1n];
        case ScalarType.UINT32:
        case ScalarType.FIXED32:
            return [0n, 2n ** 32n - 1n];
        case ScalarType.INT64:
        case ScalarType.SINT64:
        case ScalarType.SFIXED64:
            return [-(2n ** 63n), 2n ** 63n - 1n];
        case ScalarType.UINT64:
        case ScalarType.FIXED64:
            return [0n, 2n ** 64n - 1n];
        default:
            return undefined;
    }
}

const CANONICAL_INTEGER = /^(0|-?[1-9][0-9]*)$/;

/**
 * Whether a string is the canonical decimal form of an integer inside the range of the type.
 * The encoder reads `"01"`, `" 1"`, `"+1"`, `"0x10"`, `"1e3"` and `""` as 1, 1, 1, 16, 1000 or 0 and
 * `"-0"` as 0, so what it writes is not the string that was given; only the canonical form survives.
 */
function isCanonicalInteger(scalar: ScalarType, text: string): boolean {
    const range = integerRange(scalar);
    if (range === undefined || !CANONICAL_INTEGER.test(text)) {
        return false;
    }
    const number = BigInt(text);
    return number >= range[0] && number <= range[1];
}

/** Whether a string survives UTF-8 encoding: a lone surrogate would be written as U+FFFD. */
function isWellFormed(text: string): boolean {
    return text.isWellFormed();
}

/**
 * Problem of a map key. A key is a string in a JS object, and the encoder parses it by the key type, so
 * the string must be the canonical form of the key it stands for: an integer in its range without leading
 * zeros, sign `+`, spaces or exponent, `"true"` or `"false"` for a bool (any other string is `true`).
 */
function mapKeyProblem(scalar: ScalarType, key: string): string | undefined {
    if (scalar === ScalarType.STRING) {
        return isWellFormed(key) ? undefined : "a well-formed string (it has a lone surrogate)";
    }
    if (scalar === ScalarType.BOOL) {
        return key === "true" || key === "false" ? undefined : '"true" or "false"';
    }
    return isCanonicalInteger(scalar, key) ? undefined : "the canonical decimal form of an integer inside the range of the key type";
}

/** What a scalar field accepts, as `MessageInitShape` types it. Range of 32-bit numbers and NaN are left to the encoder dry run. */
function scalarProblem(scalar: ScalarType, value: unknown): string | undefined {
    switch (scalar) {
        case ScalarType.STRING:
            return typeof value === "string" && isWellFormed(value) ? undefined : "a well-formed string";
        case ScalarType.BOOL:
            return typeof value === "boolean" ? undefined : "a boolean";
        case ScalarType.BYTES: {
            // `create()` turns an array of byte values into a Uint8Array. An ArrayBuffer or a DataView is not
            // one and would be written as empty bytes; a hole, 256, 1.5 or -1 in an array would be wrapped to a byte.
            if (value instanceof Uint8Array) {
                return undefined;
            }
            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const byte: unknown = value[index];
                    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
                        return "a Uint8Array or an array of byte values (integers from 0 to 255, no holes)";
                    }
                }
                return undefined;
            }
            return "a Uint8Array or an array of byte values";
        }
        case ScalarType.INT64:
        case ScalarType.UINT64:
        case ScalarType.SINT64:
        case ScalarType.FIXED64:
        case ScalarType.SFIXED64: {
            const range = integerRange(scalar);
            const expected = "an integer inside the range of the type, as a bigint, a safe integer or a canonical decimal string";
            if (typeof value === "bigint") {
                return range !== undefined && value >= range[0] && value <= range[1] ? undefined : expected;
            }
            if (typeof value === "number") {
                return Number.isSafeInteger(value) && range !== undefined && BigInt(value) >= range[0] && BigInt(value) <= range[1] ? undefined : expected;
            }
            return typeof value === "string" && isCanonicalInteger(scalar, value) ? undefined : expected;
        }
        default:
            return typeof value === "number" ? undefined : "a number";
    }
}

/** A JSON value, as a `google.protobuf.Struct` field holds it. `undefined` inside an object is an absent key. */
function jsonValueProblem(value: unknown, path: string): string | undefined {
    if (value === null || (typeof value === "string" && isWellFormed(value)) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            const problem = jsonValueProblem(item, `${path}[${index}]`);
            if (problem !== undefined) {
                return problem;
            }
        }
        return undefined;
    }
    if (isPlainObject(value)) {
        return jsonObjectProblem(value, path);
    }
    return `${path} must be a JSON value`;
}

/**
 * First problem of a value held in a `google.protobuf.Struct` field: it must be a plain JSON object whose
 * keys are well formed and whose values are JSON values. A ready Struct message is refused by the caller.
 */
function jsonObjectProblem(value: unknown, path: string): string | undefined {
    if (!isPlainObject(value)) {
        return `${path} (google.protobuf.Struct) must be a plain JSON object`;
    }
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) {
            continue;
        }
        // A key with a lone surrogate is written as U+FFFD, so the response would hold another key.
        if (!isWellFormed(key)) {
            return `the key ${JSON.stringify(key)} of ${path} must be a well-formed string (it has a lone surrogate)`;
        }
        const problem = jsonValueProblem(item, `${path}.${key}`);
        if (problem !== undefined) {
            return problem;
        }
    }
    return undefined;
}

/** First problem of a value for one element slot (a singular field, a list item or a map value), or `undefined`. */
function elementProblem(kind: "scalar" | "enum" | "message", field: DescField, value: unknown, path: string): string | undefined {
    if (kind === "scalar") {
        const expected = scalarProblem((field as { scalar: ScalarType }).scalar, value);
        return expected === undefined ? undefined : `${path} must be ${expected}`;
    }
    if (kind === "enum") {
        return typeof value === "number" && Number.isInteger(value) ? undefined : `${path} must be an integer enum number`;
    }
    const schema = (field as { message: DescMessage }).message;
    // protobuf-es gives two well-known types a special form in a field, and `create()` reads that form:
    // a wrapper (StringValue, Int64Value, ...) in a singular field outside a oneof is its bare scalar,
    // and a Struct (outside google.protobuf.Value) is a JSON object. A message object in their place
    // is accepted by `create()` but encodes wrongly, so it is refused here.
    if (field.fieldKind === "message" && field.oneof === undefined && isWrapperDesc(schema)) {
        const wrapped = schema.fields[0] as DescField & { scalar: ScalarType };
        const expected = scalarProblem(wrapped.scalar, value);
        return expected === undefined ? undefined : `${path} (${schema.typeName}) must be ${expected}, not a message object`;
    }
    if (schema.typeName === "google.protobuf.Struct" && field.parent.typeName !== "google.protobuf.Value") {
        // A ready Struct message is accepted by `create()` but its `$typeName` and `fields` keys would be
        // written as the entries of the JSON object. A plain object that only carries some other `$typeName`
        // is just a JSON object and passes.
        if (isMessage(value, schema)) {
            return `${path} (google.protobuf.Struct) must be a plain JSON object, not a Struct message`;
        }
        return jsonObjectProblem(value, path);
    }
    if (isMessage(value, schema)) {
        return undefined;
    }
    return isPlainObject(value) ? initProblem(schema, value, path) : `${path} must be a ${schema.typeName} message or a plain object`;
}

/**
 * First problem of a value for a field of any cardinality: a list must be an array and a map a plain object
 * with canonical keys, each element then goes through the same check as a singular value.
 */
function fieldProblem(field: DescField, value: unknown, path: string): string | undefined {
    switch (field.fieldKind) {
        case "list": {
            if (!Array.isArray(value)) {
                return `${path} must be an array`;
            }
            for (const [index, item] of value.entries()) {
                const problem = elementProblem(field.listKind, field, item, `${path}[${index}]`);
                if (problem !== undefined) {
                    return problem;
                }
            }
            return undefined;
        }
        case "map": {
            if (!isPlainObject(value)) {
                return `${path} must be a plain object`;
            }
            for (const [key, item] of Object.entries(value)) {
                const keyProblem = mapKeyProblem((field as { mapKey: ScalarType }).mapKey, key);
                if (keyProblem !== undefined) {
                    return `the key ${JSON.stringify(key)} of ${path} must be ${keyProblem}`;
                }
                const problem = elementProblem(field.mapKind, field, item, `${path}[${JSON.stringify(key)}]`);
                if (problem !== undefined) {
                    return problem;
                }
            }
            return undefined;
        }
        default:
            return elementProblem(field.fieldKind, field, value, path);
    }
}

/**
 * First problem of a plain object as the initialiser of `schema`, or `undefined` when there is none.
 *
 * A key is a field name (`localName`) or, for fields of a oneof, the name of the oneof holding
 * `{ case, value }`; the name of a member field is refused, because `create()` would drop it.
 * `undefined` as a value leaves the field unset, as `MessageInitShape` allows; `null` is refused.
 */
export function initProblem(schema: DescMessage, init: Record<string, unknown>, path = "the object"): string | undefined {
    const fields = new Map(schema.fields.filter((field) => field.oneof === undefined).map((field) => [field.localName, field]));
    const oneofs = new Map(schema.oneofs.map((oneof) => [oneof.localName, oneof]));
    for (const [key, value] of Object.entries(init)) {
        const where = path === "the object" ? key : `${path}.${key}`;
        const oneof = oneofs.get(key);
        if (oneof !== undefined) {
            if (value === undefined) {
                continue;
            }
            // Only `case` and `value` mean anything; `create()` drops any other key, such as a second member set next to the first.
            if (!isPlainObject(value) || (value.case !== undefined && typeof value.case !== "string") || Object.keys(value).some((name) => name !== "case" && name !== "value")) {
                return `${where} must be { case, value } of the oneof`;
            }
            if (value.case === undefined) {
                continue;
            }
            const member = oneof.fields.find((candidate) => candidate.localName === value.case);
            if (member === undefined) {
                return `${where}.case must be one of ${oneof.fields.map((candidate) => candidate.localName).join(", ")}`;
            }
            const problem = fieldProblem(member, value.value, `${where}.value`);
            if (problem !== undefined) {
                return problem;
            }
            continue;
        }
        const field = fields.get(key);
        if (field === undefined) {
            const inOneof = schema.fields.find((candidate) => candidate.localName === key && candidate.oneof !== undefined);
            return inOneof?.oneof === undefined
                ? `${where} is not a field of ${schema.typeName}`
                : `${where} belongs to the oneof ${inOneof.oneof.localName}; set it as ${inOneof.oneof.localName}: { case: "${key}", value }`;
        }
        if (value === undefined) {
            continue;
        }
        const problem = fieldProblem(field, value, where);
        if (problem !== undefined) {
            return problem;
        }
    }
    return undefined;
}

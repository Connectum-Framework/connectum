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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** What a scalar field accepts, as `MessageInitShape` types it. Range and NaN are left to the encoder dry run. */
function scalarProblem(scalar: ScalarType, value: unknown): string | undefined {
    switch (scalar) {
        case ScalarType.STRING:
            return typeof value === "string" ? undefined : "a string";
        case ScalarType.BOOL:
            return typeof value === "boolean" ? undefined : "a boolean";
        case ScalarType.BYTES:
            // `create()` turns an array of byte values into a Uint8Array.
            return value instanceof Uint8Array || (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
                ? undefined
                : "a Uint8Array or an array of byte values";
        case ScalarType.INT64:
        case ScalarType.UINT64:
        case ScalarType.SINT64:
        case ScalarType.FIXED64:
        case ScalarType.SFIXED64:
            return typeof value === "bigint" || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
                ? undefined
                : "a bigint, a safe integer or a numeric string";
        default:
            return typeof value === "number" ? undefined : "a number";
    }
}

/** A JSON value, as a `google.protobuf.Struct` field holds it. `undefined` inside an object is an absent key. */
function jsonValueProblem(value: unknown, path: string): string | undefined {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
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

function jsonObjectProblem(value: unknown, path: string): string | undefined {
    if (!isPlainObject(value)) {
        return `${path} (google.protobuf.Struct) must be a plain JSON object`;
    }
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) {
            continue;
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
        return jsonObjectProblem(value, path);
    }
    if (isMessage(value, schema)) {
        return undefined;
    }
    return isPlainObject(value) ? initProblem(schema, value, path) : `${path} must be a ${schema.typeName} message or a plain object`;
}

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
            if (!isPlainObject(value) || (value.case !== undefined && typeof value.case !== "string")) {
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

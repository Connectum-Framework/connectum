/**
 * Factory functions for mock protobuf descriptor objects.
 *
 * These mocks create lightweight stand-ins for {@link DescMessage},
 * {@link DescField}, and {@link DescMethod} from `@bufbuild/protobuf`,
 * suitable for unit-testing interceptors and service logic without
 * compiling real `.proto` files.
 *
 * @module
 */

import type { DescField, DescMessage, DescMethod } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import { protoCamelCase, safeObjectProperty } from "@bufbuild/protobuf/reflect";
import { Edition, FieldOptionsSchema } from "@bufbuild/protobuf/wkt";
import type { MockDescFieldOptions, MockDescMessageOptions, MockDescMethodOptions } from "./types.ts";
import { assertMethodKind } from "./validate.ts";

/**
 * Field presence value of google.protobuf.FeatureSet.FieldPresence.IMPLICIT:
 * the field has no presence tracking and `create()` fills in its zero value.
 * This is the presence every proto3 singular field has.
 *
 * @internal
 */
const PRESENCE_IMPLICIT = 2;

/** Largest field number protobuf allows (2^29 - 1). @internal */
const MAX_FIELD_NUMBER = 536_870_911;

/** First and last field number the protobuf implementation reserves. @internal */
const RESERVED_FIELD_NUMBERS_FROM = 19_000;
const RESERVED_FIELD_NUMBERS_TO = 19_999;

/**
 * Protobuf scalar type names and their `google.protobuf.FieldDescriptorProto.Type` values.
 *
 * @internal
 */
const SCALAR_TYPES: ReadonlyMap<string, number> = new Map([
    ["double", 1],
    ["float", 2],
    ["int64", 3],
    ["uint64", 4],
    ["int32", 5],
    ["fixed64", 6],
    ["fixed32", 7],
    ["bool", 8],
    ["string", 9],
    ["bytes", 12],
    ["uint32", 13],
    ["sfixed32", 15],
    ["sfixed64", 16],
    ["sint32", 17],
    ["sint64", 18],
]);

/**
 * Lower-case the first character only, the way protobuf-es derives the
 * `localName` of an RPC (`GetUser` becomes `getUser`, `URLFetch` becomes
 * `uRLFetch`), and escape names that collide with built-in object properties
 * (`ToString` becomes `toString$`).
 *
 * @internal
 */
function methodLocalName(name: string): string {
    return safeObjectProperty(name.charAt(0).toLowerCase() + name.slice(1));
}

/**
 * Map a human-readable scalar type name to the corresponding protobuf
 * scalar enum value.
 *
 * @see https://protobuf.dev/programming-guides/proto3/#scalar
 * @internal
 */
function mapTypeToScalar(type: unknown, context: string): number {
    // A Map, not an object literal: a lookup by `"toString"` or `"constructor"` must not
    // find a property inherited from Object.prototype.
    const scalar = typeof type === "string" ? SCALAR_TYPES.get(type) : undefined;
    if (scalar === undefined) {
        throw new TypeError(`${context}: unknown scalar type ${JSON.stringify(type) ?? String(type)}; expected one of: ${[...SCALAR_TYPES.keys()].join(", ")}`);
    }
    return scalar;
}

/**
 * Check a field number against the protobuf rules: an integer from 1 to 2^29 - 1 outside
 * the range 19000 to 19999, which the implementation reserves. `protoc` rejects every
 * other number, so a fixture carrying one describes a message that cannot exist.
 *
 * @internal
 */
function assertFieldNumber(fieldNumber: unknown, context: string): asserts fieldNumber is number {
    const valid =
        typeof fieldNumber === "number" &&
        Number.isInteger(fieldNumber) &&
        fieldNumber >= 1 &&
        fieldNumber <= MAX_FIELD_NUMBER &&
        !(fieldNumber >= RESERVED_FIELD_NUMBERS_FROM && fieldNumber <= RESERVED_FIELD_NUMBERS_TO);
    if (!valid) {
        throw new RangeError(
            `${context}: field number ${String(fieldNumber)} is not allowed; use an integer from 1 to ${MAX_FIELD_NUMBER}, outside ${RESERVED_FIELD_NUMBERS_FROM} to ${RESERVED_FIELD_NUMBERS_TO}`,
        );
    }
}

/**
 * Create a mock {@link DescField} descriptor.
 *
 * Produces a minimal object that satisfies the `DescField` shape expected by
 * ConnectRPC interceptors and protobuf utilities.
 *
 * The field is a proto3 singular scalar field with implicit presence: like a
 * compiled descriptor, `getDefaultValue()` returns `undefined` (so `create()`
 * fills in the scalar zero value) and `longAsString` is `false`.
 *
 * With `isSensitive: true`, `proto.options` is a real `google.protobuf.FieldOptions`
 * message with `debugRedact` set to `true`, as in a compiled descriptor; without it
 * `proto.options` is `undefined`.
 *
 * Limit: a field created here alone has `parent` `undefined`. Fields listed by
 * {@link createMockDescMessage} are linked to their message through `parent`, which
 * the protobuf-es helpers that read `field.parent` (`toBinary`, `isFieldSet`,
 * `equals`, `clone`) need; declare the field through that factory when a test passes
 * the descriptor to them.
 *
 * @param name    - The field's name as written in the `.proto` file (for example
 *   `user_id`). `localName` and `jsonName` are derived from it by the protobuf-es
 *   rules: `user_id` gives `userId`, and a name that collides with a built-in
 *   object property (`constructor`, `toString`, `toJSON`, `valueOf`) gets a `$`
 *   suffix in `localName`. A name that is already camelCase is kept unchanged.
 *   A custom `json_name` option cannot be expressed.
 * @param options - Optional overrides for field number, scalar type, and sensitivity.
 * @returns A mock `DescField` object.
 * @throws TypeError when `options.type` is not one of the protobuf scalar type names
 *   (`double`, `float`, `int64`, `uint64`, `int32`, `fixed64`, `fixed32`, `bool`,
 *   `string`, `bytes`, `uint32`, `sfixed32`, `sfixed64`, `sint32`, `sint64`); `"message"`
 *   and `"enum"` are field kinds, not scalar types. The message names the field and the value.
 * @throws RangeError when `options.fieldNumber` is not an integer from 1 to 536870911
 *   outside the reserved range 19000 to 19999.
 *
 * @example
 * ```ts
 * import { createMockDescField } from "@connectum/testing";
 *
 * const field = createMockDescField("user_id", { type: "int32", fieldNumber: 1 });
 * // field.name      === "user_id"
 * // field.localName === "userId"
 * // field.scalar    === 5  (INT32)
 * ```
 */
export function createMockDescField(name: string, options?: MockDescFieldOptions): DescField {
    return buildField(name, options, `createMockDescField: field "${name}"`);
}

/**
 * Build a field descriptor; `context` prefixes the errors so a failure inside
 * {@link createMockDescMessage} names the message as well as the field.
 *
 * @internal
 */
function buildField(name: string, options: MockDescFieldOptions | undefined, context: string): DescField {
    const fieldNumber = options?.fieldNumber ?? 1;
    assertFieldNumber(fieldNumber, context);
    const scalar = mapTypeToScalar(options?.type === undefined ? "string" : options.type, context);
    const jsonName = protoCamelCase(name);
    return {
        kind: "field",
        name,
        localName: safeObjectProperty(jsonName),
        jsonName,
        fieldKind: "scalar",
        presence: PRESENCE_IMPLICIT,
        longAsString: false,
        getDefaultValue: () => undefined,
        scalar,
        number: fieldNumber,
        repeated: false,
        packed: false,
        optional: false,
        proto: {
            options: options?.isSensitive ? create(FieldOptionsSchema, { debugRedact: true }) : undefined,
        },
        parent: undefined,
        oneof: undefined,
    } as unknown as DescField;
}

/**
 * Create a mock {@link DescMessage} descriptor with all required structural
 * properties.
 *
 * `members` lists the standalone fields in declaration order followed by the
 * oneof groups, so `create()` from `@bufbuild/protobuf` fills every declared
 * field with its zero value and every oneof group with `{ case: undefined }`,
 * as it does for a compiled descriptor.
 *
 * Field numbers that are not given explicitly continue from the highest number
 * used so far (`max + 1`). Two fields with the same number make the factory
 * throw, as `protoc` rejects such a message.
 *
 * Like a compiled descriptor, every field points back at the message through
 * `parent`, the message itself has `parent` `undefined` (a top-level message), and
 * its `file` reports the proto3 edition (`edition` is `Edition.EDITION_PROTO3`;
 * `proto.syntax` is `"proto3"` and `proto.edition` is `Edition.EDITION_UNKNOWN`).
 * That makes `toBinary`, `isFieldSet`, `equals` and `clone` of `@bufbuild/protobuf`
 * accept the mock. The parent link is circular, so `JSON.stringify` of a mock
 * message that has fields throws a `TypeError`, as it does for a compiled
 * descriptor: serialise `typeName` and the field names instead of the descriptor.
 *
 * Limitations: a mock oneof group has no fields (`fields: []`) and the declared
 * fields are not attached to it, and a custom `json_name` option cannot be
 * expressed.
 *
 * @param typeName - Fully-qualified protobuf type name (e.g. `"acme.v1.User"`).
 * @param options  - Optional field and oneof definitions. A field `name` is the
 *   proto name (see {@link createMockDescField}).
 * @returns A mock `DescMessage` object.
 * @throws Error when two fields share the same field number.
 * @throws TypeError when a field `type` is not a protobuf scalar type name, as in
 *   {@link createMockDescField}.
 * @throws RangeError when a field number is not allowed, as in {@link createMockDescField}
 *   (this includes a number continued automatically past 18999).
 *
 * @example
 * ```ts
 * import { createMockDescMessage } from "@connectum/testing";
 *
 * const msg = createMockDescMessage("acme.v1.User", {
 *   fields: [
 *     { name: "id", type: "int32" },
 *     { name: "email", type: "string" },
 *   ],
 * });
 * // msg.typeName === "acme.v1.User"
 * // msg.name     === "User"
 * // msg.fields   === [DescField, DescField]
 * ```
 */
export function createMockDescMessage(typeName: string, options?: MockDescMessageOptions): DescMessage {
    const name = typeName.split(".").pop() ?? typeName;

    const usedNumbers = new Set<number>();
    let highestNumber = 0;
    const fields: DescField[] = (options?.fields ?? []).map((f) => {
        const fieldNumber = f.fieldNumber ?? highestNumber + 1;
        const fieldOpts: MockDescFieldOptions = { fieldNumber };
        if (f.type !== undefined) {
            fieldOpts.type = f.type;
        }
        if (f.isSensitive !== undefined) {
            fieldOpts.isSensitive = f.isSensitive;
        }
        // Built first: the type and the number are checked before the number is compared with the others.
        const field = buildField(f.name, fieldOpts, `${typeName}: field "${f.name}"`);
        if (usedNumbers.has(fieldNumber)) {
            throw new Error(`${typeName}: field number ${fieldNumber} is used by more than one field (field "${f.name}")`);
        }
        usedNumbers.add(fieldNumber);
        highestNumber = Math.max(highestNumber, fieldNumber);
        return field;
    });

    const oneofs = (options?.oneofs ?? []).map((oneofName) => ({
        name: oneofName,
        localName: safeObjectProperty(protoCamelCase(oneofName)),
        fields: [],
        kind: "oneof",
    }));

    const message = {
        kind: "message",
        typeName,
        name,
        fields,
        field: Object.fromEntries(fields.map((f) => [f.localName, f])),
        oneofs,
        members: [...fields, ...oneofs],
        nestedEnums: [],
        nestedMessages: [],
        nestedExtensions: [],
        parent: undefined,
        proto: { options: undefined },
        // The file of a compiled `syntax = "proto3"` file: `edition` is the proto3 edition
        // and its descriptor proto names the syntax while leaving `edition` unknown.
        file: {
            name: `${typeName.replace(/\./g, "/")}.proto`,
            edition: Edition.EDITION_PROTO3,
            proto: { syntax: "proto3", edition: Edition.EDITION_UNKNOWN },
        },
    } as unknown as DescMessage;

    // A compiled field points back at the message that declares it, and protobuf-es
    // reads that link (`toBinary`, `isFieldSet`, `equals`, `clone`). `DescField.parent`
    // is readonly and the message only exists now, so the link is set through a mutable view.
    for (const field of fields) {
        (field as { parent: DescMessage }).parent = message;
    }

    return message;
}

/**
 * Create a mock {@link DescMethod} descriptor.
 *
 * When `input` or `output` are not provided, default mock messages are created
 * automatically based on the method name (e.g. `test.GetUserRequest` /
 * `test.GetUserResponse`).
 *
 * Limit: the method has `parent` `undefined`, so code that reads the service of the
 * method (for example `createMethodUrl`) cannot use it. Use `createFakeMethod(service, name)`
 * for a method attached to a service.
 *
 * @param name    - The RPC method name (PascalCase by convention).
 * @param options - Optional overrides for kind, input/output, and redaction
 *   (`useSensitiveRedaction` is deprecated: `MethodOptions` has no such property, so the
 *   `{ debug_redact: true }` marker it produces is fixture-only and nothing in Connectum reads it).
 * @returns A mock `DescMethod` object.
 * @throws TypeError when `options.kind` is not `unary`, `server_streaming`,
 *   `client_streaming` or `bidi_streaming`.
 *
 * @example
 * ```ts
 * import { createMockDescMethod, createMockDescMessage } from "@connectum/testing";
 *
 * const method = createMockDescMethod("GetUser");
 * // method.name       === "GetUser"
 * // method.localName  === "getUser"
 * // method.methodKind === "unary"
 *
 * const streaming = createMockDescMethod("ListUsers", {
 *   kind: "server_streaming",
 * });
 * ```
 */
export function createMockDescMethod(name: string, options?: MockDescMethodOptions): DescMethod {
    const kind = options?.kind === undefined ? "unary" : options.kind;
    assertMethodKind(kind, `createMockDescMethod: method "${name}"`);
    const defaultInput = createMockDescMessage(`test.${name}Request`);
    const defaultOutput = createMockDescMessage(`test.${name}Response`);

    return {
        kind: "rpc",
        name,
        localName: methodLocalName(name),
        parent: undefined,
        methodKind: kind,
        input: options?.input ?? defaultInput,
        output: options?.output ?? defaultOutput,
        deprecated: false,
        proto: {
            options: options?.useSensitiveRedaction ? { debug_redact: true } : undefined,
        },
    } as unknown as DescMethod;
}

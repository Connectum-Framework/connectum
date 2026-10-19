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
import { protoCamelCase, safeObjectProperty } from "@bufbuild/protobuf/reflect";
import type { MockDescFieldOptions, MockDescMessageOptions, MockDescMethodOptions } from "./types.ts";

/**
 * Field presence value of google.protobuf.FeatureSet.FieldPresence.IMPLICIT:
 * the field has no presence tracking and `create()` fills in its zero value.
 * This is the presence every proto3 singular field has.
 *
 * @internal
 */
const PRESENCE_IMPLICIT = 2;

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
function mapTypeToScalar(type: string): number {
    const scalars: Record<string, number> = {
        double: 1,
        float: 2,
        int64: 3,
        uint64: 4,
        int32: 5,
        fixed64: 6,
        fixed32: 7,
        bool: 8,
        string: 9,
        bytes: 12,
        uint32: 13,
        sfixed32: 15,
        sfixed64: 16,
        sint32: 17,
        sint64: 18,
    };
    return scalars[type] ?? 9; // default to STRING
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
 * @param name    - The field's name as written in the `.proto` file (for example
 *   `user_id`). `localName` and `jsonName` are derived from it by the protobuf-es
 *   rules: `user_id` gives `userId`, and a name that collides with a built-in
 *   object property (`constructor`, `toString`, `toJSON`, `valueOf`) gets a `$`
 *   suffix in `localName`. A name that is already camelCase is kept unchanged.
 *   A custom `json_name` option cannot be expressed.
 * @param options - Optional overrides for field number, scalar type, and sensitivity.
 * @returns A mock `DescField` object.
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
        scalar: mapTypeToScalar(options?.type ?? "string"),
        number: options?.fieldNumber ?? 1,
        repeated: false,
        packed: false,
        optional: false,
        proto: {
            options: options?.isSensitive ? { debug_redact: true } : undefined,
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
 * Limitations: a mock oneof group has no fields (`fields: []`) and the declared
 * fields are not attached to it, and a custom `json_name` option cannot be
 * expressed.
 *
 * @param typeName - Fully-qualified protobuf type name (e.g. `"acme.v1.User"`).
 * @param options  - Optional field and oneof definitions. A field `name` is the
 *   proto name (see {@link createMockDescField}).
 * @returns A mock `DescMessage` object.
 * @throws Error when two fields share the same field number.
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
        if (usedNumbers.has(fieldNumber)) {
            throw new Error(`${typeName}: field number ${fieldNumber} is used by more than one field (field "${f.name}")`);
        }
        usedNumbers.add(fieldNumber);
        highestNumber = Math.max(highestNumber, fieldNumber);
        const fieldOpts: MockDescFieldOptions = { fieldNumber };
        if (f.type !== undefined) {
            fieldOpts.type = f.type;
        }
        return createMockDescField(f.name, fieldOpts);
    });

    const oneofs = (options?.oneofs ?? []).map((oneofName) => ({
        name: oneofName,
        localName: safeObjectProperty(protoCamelCase(oneofName)),
        fields: [],
        kind: "oneof",
    }));

    return {
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
        file: {
            name: `${typeName.replace(/\./g, "/")}.proto`,
            proto: { edition: "EDITION_PROTO3" },
        },
    } as unknown as DescMessage;
}

/**
 * Create a mock {@link DescMethod} descriptor.
 *
 * When `input` or `output` are not provided, default mock messages are created
 * automatically based on the method name (e.g. `test.GetUserRequest` /
 * `test.GetUserResponse`).
 *
 * @param name    - The RPC method name (PascalCase by convention).
 * @param options - Optional overrides for kind, input/output, and redaction.
 * @returns A mock `DescMethod` object.
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
    const defaultInput = createMockDescMessage(`test.${name}Request`);
    const defaultOutput = createMockDescMessage(`test.${name}Response`);

    return {
        kind: "rpc",
        name,
        localName: methodLocalName(name),
        parent: undefined,
        methodKind: options?.kind ?? "unary",
        input: options?.input ?? defaultInput,
        output: options?.output ?? defaultOutput,
        deprecated: false,
        proto: {
            options: options?.useSensitiveRedaction ? { debug_redact: true } : undefined,
        },
    } as unknown as DescMethod;
}

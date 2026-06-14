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
import type { MockDescFieldOptions, MockDescMessageOptions, MockDescMethodOptions } from "./types.ts";

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
 * @param localName - The field's local (camelCase) name.
 * @param options   - Optional overrides for field number, scalar type, and sensitivity.
 * @returns A mock `DescField` object.
 *
 * @example
 * ```ts
 * import { createMockDescField } from "@connectum/testing";
 *
 * const field = createMockDescField("userId", { type: "int32", fieldNumber: 1 });
 * // field.localName === "userId"
 * // field.scalar    === 5  (INT32)
 * ```
 */
export function createMockDescField(localName: string, options?: MockDescFieldOptions): DescField {
    return {
        kind: "field",
        name: localName,
        localName,
        jsonName: localName,
        fieldKind: "scalar",
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
 * **Important**: the returned object always includes `members: []` which is
 * required by `create()` from `@bufbuild/protobuf` — without it the runtime
 * crashes.
 *
 * @param typeName - Fully-qualified protobuf type name (e.g. `"acme.v1.User"`).
 * @param options  - Optional field and oneof definitions.
 * @returns A mock `DescMessage` object.
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

    const fields: DescField[] = (options?.fields ?? []).map((f, i) => {
        const fieldOpts: MockDescFieldOptions = {
            fieldNumber: f.fieldNumber ?? i + 1,
        };
        if (f.type !== undefined) {
            fieldOpts.type = f.type;
        }
        return createMockDescField(f.name, fieldOpts);
    });

    return {
        kind: "message",
        typeName,
        name,
        fields,
        field: Object.fromEntries(fields.map((f) => [f.localName, f])),
        oneofs: (options?.oneofs ?? []).map((oneofName) => ({
            name: oneofName,
            localName: oneofName,
            fields: [],
            kind: "oneof",
        })),
        members: [], // CRITICAL: required for create() from @bufbuild/protobuf
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
        localName: name.charAt(0).toLowerCase() + name.slice(1),
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

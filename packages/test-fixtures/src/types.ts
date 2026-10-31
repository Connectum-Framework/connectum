/**
 * Type definitions for @connectum/test-fixtures.
 *
 * @module
 */

// The factories these options configure live in the package's main entry, a
// sibling module, so links to them are written as `index.<name>`: a bare name
// cannot be resolved from this module, where the factories are not in scope.

import type { DescMessage } from "@bufbuild/protobuf";

// ============================================================
// Mock Request
// ============================================================

/** Options for {@link index.createMockRequest | createMockRequest}. */
export interface MockRequestOptions {
    /** Service type name. Default: `'test.TestService'` */
    service?: string;
    /** Method name. Default: `'TestMethod'` */
    method?: string;
    /** Request message payload. Default: `{}` */
    message?: unknown;
    /** Streaming request flag. Default: `false` */
    stream?: boolean;
    /** Request URL. Auto-generated from service/method if omitted. */
    url?: string;
    /** Request headers. Default: `new Headers()` */
    headers?: Headers;
}

// ============================================================
// Mock Next
// ============================================================

/** Options for {@link index.createMockNext | createMockNext} and {@link index.createMockNextSlow | createMockNextSlow}. */
export interface MockNextOptions {
    /** Response message. Default: `{ result: 'success' }` */
    message?: unknown;
    /** Streaming response flag. Default: `false` */
    stream?: boolean;
}

// ============================================================
// Mock Protobuf Descriptors
// ============================================================

/**
 * Name of a protobuf scalar type, as written in a `.proto` file
 * (https://protobuf.dev/programming-guides/proto3/#scalar). Any other name throws.
 */
export type MockScalarType =
    | "double"
    | "float"
    | "int64"
    | "uint64"
    | "int32"
    | "fixed64"
    | "fixed32"
    | "bool"
    | "string"
    | "bytes"
    | "uint32"
    | "sfixed32"
    | "sfixed64"
    | "sint32"
    | "sint64";

/** Options for {@link index.createMockDescMessage | createMockDescMessage}. */
export interface MockDescMessageOptions {
    /**
     * Field definitions. Default: `[]`
     *
     * `name` is the field name as written in the `.proto` file; `localName` is
     * derived from it (`user_id` gives `userId`). `fieldNumber` defaults to the
     * highest number used so far plus one; a repeated number throws, and so does a
     * number outside 1 to 536870911 or inside the reserved range 19000 to 19999.
     * `type` is a {@link MockScalarType}; any other value throws.
     */
    fields?: Array<{
        name: string;
        type?: MockScalarType;
        fieldNumber?: number;
        /** Mark the field as sensitive, as in {@link MockDescFieldOptions.isSensitive}. Default: `false` */
        isSensitive?: boolean;
    }>;
    /** Oneof group names. A mock oneof group has no fields. Default: `[]` */
    oneofs?: string[];
}

/** Options for {@link index.createMockDescField | createMockDescField}. */
export interface MockDescFieldOptions {
    /**
     * Mark the field as sensitive: `proto.options` becomes a `google.protobuf.FieldOptions`
     * message with `debugRedact` set to `true`, as in a compiled descriptor.
     * Default: `false`
     */
    isSensitive?: boolean;
    /**
     * Proto field number, an integer from 1 to 536870911 outside the reserved range
     * 19000 to 19999; any other value throws. Default: `1` (auto-incremented in
     * {@link index.createMockDescMessage | createMockDescMessage})
     */
    fieldNumber?: number;
    /** Field scalar type; a name that is not a {@link MockScalarType} throws. Default: `'string'` */
    type?: MockScalarType;
}

/** Options for {@link index.createMockDescMethod | createMockDescMethod}. */
export interface MockDescMethodOptions {
    /** Input message descriptor. */
    input?: DescMessage;
    /** Output message descriptor. */
    output?: DescMessage;
    /** Method kind. Default: `'unary'` */
    kind?: "unary" | "server_streaming" | "client_streaming" | "bidi_streaming";
    /**
     * Put the fixture-only marker `{ debug_redact: true }` into `proto.options`. Default: `false`
     *
     * @deprecated `google.protobuf.MethodOptions` has no `debug_redact` field: the marker
     *   exists only in this fixture, nothing in Connectum reads it, and it does not conform
     *   to a compiled descriptor. It keeps its behaviour for existing tests. Mark a field
     *   with `isSensitive` instead.
     */
    useSensitiveRedaction?: boolean;
}

// ============================================================
// Mock Stream
// ============================================================

/** Options for {@link index.createMockStream | createMockStream}. */
export interface MockStreamOptions {
    /**
     * Delay in milliseconds before each yielded item: a finite number from 0 to 2147483647
     * (`0` or omitted means no delay). Any other value throws, because the timer would
     * turn it into 1 ms.
     */
    delayMs?: number;
}

// ============================================================
// Fake Service / Method
// ============================================================

/** Options for {@link index.createFakeService | createFakeService}. */
export interface FakeServiceOptions {
    /** Service type name. Default: `'test.v1.TestService'` */
    typeName?: string;
    /** Service name (short). Default: derived from typeName */
    name?: string;
}

/** Options for {@link index.createFakeMethod | createFakeMethod}. */
export interface FakeMethodOptions {
    /** Method kind. Default: `'unary'` */
    methodKind?: "unary" | "server_streaming" | "client_streaming" | "bidi_streaming";
    /**
     * Whether to register the method in service.methods. Default: `false`
     * Registering a name that the service already has throws.
     */
    register?: boolean;
}

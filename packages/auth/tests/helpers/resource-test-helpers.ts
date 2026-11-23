/**
 * Real protobuf descriptors for the resource-authorization tests.
 *
 * Field-path resolution needs the request message descriptor (`method.input`), which the fake
 * descriptors of `proto-test-helpers.ts` do not have. The file below is assembled at runtime from a
 * `FileDescriptorProto`, so each test names exactly the messages and methods it needs without a
 * second code-generation fixture.
 */

import type { DescMethod, DescService, Message, MessageInitShape } from "@bufbuild/protobuf";
import { create, createFileRegistry } from "@bufbuild/protobuf";
import type { DescriptorProto, FieldDescriptorProto } from "@bufbuild/protobuf/wkt";
import { FieldDescriptorProto_Label, FieldDescriptorProto_Type, FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import type { ResourceRequirementSchema } from "#gen/connectum/auth/v1/options_pb.js";
import { createMethodOptions, createServiceOptions } from "./proto-test-helpers.ts";

export const PACKAGE = "test.resource.v1";
export const SERVICE = `${PACKAGE}.ResourceService`;

type MethodKind = "unary" | "server" | "client" | "bidi";

export interface ResourceMethodSpec {
    /** Request message name, one of the messages defined in this file. */
    readonly input: string;
    /** @default "unary" */
    readonly kind?: MethodKind;
    readonly auth?: {
        readonly public?: boolean;
        readonly internal?: boolean;
        readonly policy?: string;
        readonly requires?: { roles?: string[]; scopes?: string[] };
        readonly resources?: ReadonlyArray<MessageInitShape<typeof ResourceRequirementSchema>>;
    };
}

function field(name: string, number: number, options: { type?: FieldDescriptorProto_Type; typeName?: string; repeated?: boolean; oneofIndex?: number } = {}): FieldDescriptorProto {
    return {
        name,
        number,
        label: options.repeated ? FieldDescriptorProto_Label.REPEATED : FieldDescriptorProto_Label.OPTIONAL,
        type: options.type ?? FieldDescriptorProto_Type.STRING,
        ...(options.typeName !== undefined && { typeName: options.typeName }),
        ...(options.oneofIndex !== undefined && { oneofIndex: options.oneofIndex }),
        jsonName: name,
    } as FieldDescriptorProto;
}

const MESSAGE = FieldDescriptorProto_Type.MESSAGE;

/** The request messages every test can aim a resource rule at. */
function messages(): DescriptorProto[] {
    return [
        // A flat reference: `id`, plus `kind` for rules that read the type from the request.
        { name: "DocRequest", field: [field("id", 1), field("kind", 2), field("count", 3, { type: FieldDescriptorProto_Type.INT32 })] },
        { name: "Ref", field: [field("type", 1), field("id", 2)] },
        // Two named objects: a move names a source and a target.
        { name: "MoveRequest", field: [field("source", 1, { type: MESSAGE, typeName: `.${PACKAGE}.Ref` }), field("target", 2, { type: MESSAGE, typeName: `.${PACKAGE}.Ref` })] },
        // A message whose id lives in a oneof member.
        {
            name: "Target",
            field: [field("task_id", 1, { oneofIndex: 0 }), field("project_id", 2, { oneofIndex: 0 })],
            oneofDecl: [{ name: "kind" }],
        },
        { name: "OneofRequest", field: [field("target", 1, { type: MESSAGE, typeName: `.${PACKAGE}.Target` })] },
        // Repeated and map fields, which a path may not cross.
        {
            name: "Item",
            field: [field("id", 1)],
        },
        {
            name: "ListRequest",
            field: [
                field("items", 1, { type: MESSAGE, typeName: `.${PACKAGE}.Item`, repeated: true }),
                field("labels", 2, { type: MESSAGE, typeName: `.${PACKAGE}.ListRequest.LabelsEntry`, repeated: true }),
            ],
            nestedType: [{ name: "LabelsEntry", field: [field("key", 1), field("value", 2)], options: { mapEntry: true } }],
        },
    ] as unknown as DescriptorProto[];
}

export interface ResourceFixture {
    readonly service: DescService;
    readonly methods: Readonly<Record<string, DescMethod>>;
}

/**
 * Build a service whose methods carry the given auth options.
 *
 * @param methods - Method name to specification.
 * @param serviceAuth - Optional `service_auth` of the whole service.
 */
export function buildResourceService(
    methods: Readonly<Record<string, ResourceMethodSpec>>,
    serviceAuth?: { public?: boolean; internal?: boolean; defaultPolicy?: string },
): ResourceFixture {
    const file = create(FileDescriptorProtoSchema, {
        name: "test/resource/v1/resource.proto",
        package: PACKAGE,
        syntax: "proto3",
        messageType: messages(),
        service: [
            {
                name: "ResourceService",
                ...(serviceAuth !== undefined && { options: createServiceOptions(serviceAuth) }),
                method: Object.entries(methods).map(([name, spec]) => ({
                    name,
                    inputType: `.${PACKAGE}.${spec.input}`,
                    outputType: `.${PACKAGE}.${spec.input}`,
                    clientStreaming: spec.kind === "client" || spec.kind === "bidi",
                    serverStreaming: spec.kind === "server" || spec.kind === "bidi",
                    ...(spec.auth !== undefined && { options: createMethodOptions(spec.auth) }),
                })),
            },
        ],
    });
    const registry = createFileRegistry(create(FileDescriptorSetSchema, { file: [file] }));
    const service = registry.getService(SERVICE);
    if (service === undefined) {
        throw new Error("test fixture: service was not built");
    }
    return { service, methods: Object.fromEntries(service.methods.map((method) => [method.name, method])) };
}

/** Create a request message of the method's input type from a plain object. */
export function messageOf(method: DescMethod, init: Record<string, unknown> = {}): Message {
    return create(method.input, init as never) as Message;
}

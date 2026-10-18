/**
 * Reference descriptors and a reference transport built from the real
 * `@bufbuild/protobuf` and `@connectrpc/connect` runtimes.
 *
 * The fixture factories under test fabricate descriptor- and request-shaped
 * objects by hand. The objects produced here come from the libraries
 * themselves, so they serve as the independent oracle for "what does the real
 * thing look like" instead of copying expectations out of the factories.
 */

import { create, createFileRegistry, type DescMessage, type DescMethod, type DescService, type FileRegistry } from "@bufbuild/protobuf";
import { FieldDescriptorProto_Label, FieldDescriptorProto_Type, type FileDescriptorProto, FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { createClient, createRouterTransport, type Interceptor } from "@connectrpc/connect";

/**
 * The scalar type names accepted by `createMockDescField` and the protobuf
 * wire types they stand for (https://protobuf.dev/programming-guides/proto3/#scalar).
 */
export const SCALAR_FIELD_TYPES = [
    ["double", FieldDescriptorProto_Type.DOUBLE],
    ["float", FieldDescriptorProto_Type.FLOAT],
    ["int64", FieldDescriptorProto_Type.INT64],
    ["uint64", FieldDescriptorProto_Type.UINT64],
    ["int32", FieldDescriptorProto_Type.INT32],
    ["fixed64", FieldDescriptorProto_Type.FIXED64],
    ["fixed32", FieldDescriptorProto_Type.FIXED32],
    ["bool", FieldDescriptorProto_Type.BOOL],
    ["string", FieldDescriptorProto_Type.STRING],
    ["bytes", FieldDescriptorProto_Type.BYTES],
    ["uint32", FieldDescriptorProto_Type.UINT32],
    ["sfixed32", FieldDescriptorProto_Type.SFIXED32],
    ["sfixed64", FieldDescriptorProto_Type.SFIXED64],
    ["sint32", FieldDescriptorProto_Type.SINT32],
    ["sint64", FieldDescriptorProto_Type.SINT64],
] as const;

/** Largest field number the protobuf language specification allows. */
export const MAX_FIELD_NUMBER = 536_870_911;

/** Declares an optional, singular field of a proto3 message. */
function field(name: string, number: number, type: FieldDescriptorProto_Type, jsonName: string) {
    return { name, number, type, jsonName, label: FieldDescriptorProto_Label.OPTIONAL };
}

/**
 * RPC names are chosen to expose naming rules: the first character is lowered
 * and nothing else (`URLFetch` -> `uRLFetch`), a name that already starts in
 * lower case stays as declared, and names that collide with built-in
 * object properties get a `$` suffix.
 */
export const REAL_METHODS = [
    { name: "GetUser", kind: "unary" },
    { name: "ListUsers", kind: "server_streaming" },
    { name: "UploadUsers", kind: "client_streaming" },
    { name: "Chat", kind: "bidi_streaming" },
    { name: "URLFetch", kind: "unary" },
    { name: "ping", kind: "unary" },
    { name: "X", kind: "unary" },
    { name: "ToString", kind: "unary" },
] as const;

function buildFiles(): FileDescriptorProto[] {
    const user = create(FileDescriptorProtoSchema, {
        name: "acme/v1/user.proto",
        package: "acme.v1",
        syntax: "proto3",
        messageType: [
            {
                name: "User",
                field: [
                    field("id", 1, FieldDescriptorProto_Type.INT32, "id"),
                    field("email", 2, FieldDescriptorProto_Type.STRING, "email"),
                    field("userName", 3, FieldDescriptorProto_Type.STRING, "userName"),
                    field("big", 16, FieldDescriptorProto_Type.INT64, "big"),
                    field("payload", 2047, FieldDescriptorProto_Type.BYTES, "payload"),
                    field("last", 536_870_911, FieldDescriptorProto_Type.BOOL, "last"),
                ],
            },
            {
                name: "Scalars",
                field: SCALAR_FIELD_TYPES.map(([name, type], index) => field(name, index + 1, type, name)),
            },
            {
                name: "Snake",
                field: [field("user_id", 1, FieldDescriptorProto_Type.STRING, "userId")],
            },
            {
                name: "Login",
                field: [
                    { ...field("password", 1, FieldDescriptorProto_Type.STRING, "password"), oneofIndex: 0 },
                    { ...field("token", 2, FieldDescriptorProto_Type.STRING, "token"), oneofIndex: 0 },
                ],
                oneofDecl: [{ name: "credentials" }],
            },
        ],
        service: [
            {
                name: "UserService",
                method: REAL_METHODS.map(({ name, kind }) => ({
                    name,
                    inputType: ".acme.v1.User",
                    outputType: ".acme.v1.User",
                    clientStreaming: kind === "client_streaming" || kind === "bidi_streaming",
                    serverStreaming: kind === "server_streaming" || kind === "bidi_streaming",
                })),
            },
        ],
    });

    // A service declared without a package: its typeName is its bare name.
    const standalone = create(FileDescriptorProtoSchema, {
        name: "standalone.proto",
        syntax: "proto3",
        messageType: [{ name: "Ping" }],
        service: [
            {
                name: "Standalone",
                method: [{ name: "Ping", inputType: ".Ping", outputType: ".Ping" }],
            },
        ],
    });

    return [user, standalone];
}

let cached: FileRegistry | undefined;

/** Registry of real descriptors compiled from the files above. */
export function realRegistry(): FileRegistry {
    cached ??= createFileRegistry(create(FileDescriptorSetSchema, { file: buildFiles() }));
    return cached;
}

export function realService(typeName = "acme.v1.UserService"): DescService {
    const svc = realRegistry().getService(typeName);
    if (svc === undefined) {
        throw new Error(`reference service ${typeName} is not defined`);
    }
    return svc;
}

export function realMessage(typeName: string): DescMessage {
    const msg = realRegistry().getMessage(typeName);
    if (msg === undefined) {
        throw new Error(`reference message ${typeName} is not defined`);
    }
    return msg;
}

export function realMethod(name: string): DescMethod {
    const method = realService().methods.find((m) => m.name === name);
    if (method === undefined) {
        throw new Error(`reference method ${name} is not defined`);
    }
    return method;
}

/** Everything a real interceptor sees for one call made through a real transport. */
export interface ObservedCall {
    // biome-ignore lint/suspicious/noExplicitAny: the request/response objects are inspected structurally
    req: any;
    // biome-ignore lint/suspicious/noExplicitAny: the request/response objects are inspected structurally
    res: any;
}

/**
 * Runs a unary call and a server-streaming call through `createRouterTransport`
 * and records the `req` and `res` that a client interceptor receives.
 */
export async function observeRealCalls(): Promise<{ unary: ObservedCall; serverStreaming: ObservedCall }> {
    const svc = realService();
    const observed: ObservedCall[] = [];
    const record: Interceptor = (next) => async (req) => {
        const call: ObservedCall = { req, res: undefined };
        observed.push(call);
        call.res = await next(req);
        return call.res;
    };

    const transport = createRouterTransport(
        ({ service }) => {
            // The descriptor is compiled at run time, so the method map is not statically typed.
            service(svc, {
                getUser: () => create(realMessage("acme.v1.User"), { id: 7 }),
                async *listUsers() {
                    yield create(realMessage("acme.v1.User"), { id: 8 });
                },
            } as never);
        },
        { transport: { interceptors: [record] } },
    );

    const client = createClient(svc, transport) as unknown as {
        getUser(input: unknown): Promise<unknown>;
        listUsers(input: unknown): AsyncIterable<unknown>;
    };
    await client.getUser({ id: 1 });
    for await (const _ of client.listUsers({ id: 1 })) {
        // drain the stream so the response is fully observed
    }

    const [unary, serverStreaming] = observed;
    if (unary === undefined || serverStreaming === undefined) {
        throw new Error("reference transport did not record both calls");
    }
    return { unary, serverStreaming };
}

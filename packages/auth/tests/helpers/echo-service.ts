/**
 * Runtime-built echo service for tests that need a real server and a real
 * network client without code generation.
 *
 * The service descriptor is assembled from a file descriptor at test time, so a
 * test can give each method the exact `connectum.auth.v1` options it needs
 * (`public`, `internal`, `requires`) and still go through the shipped
 * interceptors, a listening HTTP/2 server and a client transport.
 */

import type { DescService } from "@bufbuild/protobuf";
import { create, createFileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FieldDescriptorProto_Label as Label, FieldDescriptorProto_Type as Type } from "@bufbuild/protobuf/wkt";
import { ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { defineService, type ServiceDefinition } from "@connectum/core";
import { getAuthContext } from "../../src/context.ts";
import { createMethodOptions } from "./proto-test-helpers.ts";

/** Proto auth options a test method may carry; the same shape `createMethodOptions` accepts. */
export type EchoMethodAuth = Parameters<typeof createMethodOptions>[0];

/** One method of the echo service: unary, request and response carry a single `text` field. */
export interface EchoMethod {
    readonly name: string;
    readonly auth?: EchoMethodAuth;
}

function textField() {
    return { name: "text", number: 1, type: Type.STRING, label: Label.OPTIONAL, jsonName: "text" };
}

/** Build the `acme.v1.Echo` service descriptor with the given methods. */
export function makeEchoService(methods: readonly EchoMethod[]): DescService {
    const file = create(FileDescriptorProtoSchema, {
        name: "acme/v1/echo.proto",
        package: "acme.v1",
        syntax: "proto3",
        messageType: [
            { name: "Req", field: [textField()] },
            { name: "Res", field: [textField()] },
        ],
        service: [
            {
                name: "Echo",
                method: methods.map((method) => ({
                    name: method.name,
                    inputType: ".acme.v1.Req",
                    outputType: ".acme.v1.Res",
                    ...(method.auth ? { options: createMethodOptions(method.auth) } : {}),
                })),
            },
        ],
    });
    return createFileRegistry(file, () => undefined).getService("acme.v1.Echo") as DescService;
}

/**
 * Implementation for every method of `service`: it replies with the identity the
 * handler can see, so a test can tell "the handler ran as alice" from "the handler ran
 * without an identity" and from "the call never reached the handler".
 */
export function echoRoutes(service: DescService): ServiceDefinition {
    const handlers: Record<string, () => { text: string }> = {};
    for (const method of service.methods) {
        const key = method.localName;
        handlers[key] = () => {
            const identity = getAuthContext();
            return { text: identity === undefined ? "handler ran without an identity" : `handler ran as ${JSON.stringify(identity.subject)}` };
        };
    }
    return defineService(service as never, handlers as never);
}

/** What a client sees of one call: the reply text, or the error code and the text the server sent. */
export type CallOutcome = { readonly response: { readonly text: string } } | { readonly error: { readonly code: number; readonly message: string } };

/**
 * Call one method of `service` over `transport` and report what the client saw.
 * `headers` are the request headers; an error is reported by code and sent text so a test
 * can compare it with a literal instead of with the other transport's output.
 */
export async function callEcho(service: DescService, transport: Transport, options: { method?: string; headers?: Record<string, string> } = {}): Promise<CallOutcome> {
    const method = service.methods.find((m) => m.name === (options.method ?? service.methods[0]?.name));
    if (!method) {
        throw new Error(`no method ${options.method} in ${service.typeName}`);
    }
    const client = createClient(service as never, transport) as unknown as Record<
        string,
        (request: object, callOptions: { headers?: Record<string, string> }) => Promise<{ text: string }>
    >;
    try {
        const reply = await client[method.localName]?.({ text: "ping" }, { headers: options.headers ?? {} });
        return { response: { text: reply?.text ?? "" } };
    } catch (err) {
        const error = ConnectError.from(err);
        return { error: { code: error.code, message: error.rawMessage } };
    }
}

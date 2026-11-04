/**
 * How much of a requested name a reflection error answer repeats.
 *
 * A reflection client sends names: a file path, a fully-qualified symbol, a
 * type. Nothing in the protocol makes them long, but a client could send
 * megabytes, and the server answered an unknown one with the value twice, once
 * in `error_message` and once in `original_request`. `original_request` is part
 * of the response (it says which request it answers) and stays complete; the
 * message text repeats a bounded prefix.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, type Server } from "@connectum/core";
import { ServerReflectionRequestSchema, type ServerReflectionResponse, ServerReflectionResponseSchema, ServerReflection as V1 } from "#gen/grpc/reflection/v1/reflection_pb.js";
import {
    ServerReflection as V1alpha,
    ServerReflectionRequestSchema as V1alphaRequestSchema,
    ServerReflectionResponseSchema as V1alphaResponseSchema,
} from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";

/** Longest part of a requested name that an `error_message` repeats. */
const ECHOED_NAME_LIMIT = 128;
const NOT_FOUND = 5;

type Version = "v1" | "v1alpha";

function request(version: Version, kind: "fileByFilename" | "fileContainingSymbol" | "allExtensionNumbersOfType" | "listServices", value: string) {
    return version === "v1"
        ? create(ServerReflectionRequestSchema, { messageRequest: { case: kind, value } })
        : create(V1alphaRequestSchema, { messageRequest: { case: kind, value } });
}

function extensionRequest(version: Version, containingType: string) {
    const messageRequest = { case: "fileContainingExtension", value: { containingType, extensionNumber: 7 } } as const;
    return version === "v1" ? create(ServerReflectionRequestSchema, { messageRequest }) : create(V1alphaRequestSchema, { messageRequest });
}

async function ask(transport: Transport, version: Version, message: ReturnType<typeof request>): Promise<ServerReflectionResponse> {
    async function* requests() {
        yield message;
    }
    const stream = version === "v1" ? createClient(V1, transport).serverReflectionInfo(requests() as never) : createClient(V1alpha, transport).serverReflectionInfo(requests() as never);
    for await (const response of stream as AsyncIterable<ServerReflectionResponse>) {
        return response;
    }
    throw new Error("the reflection stream ended without a response");
}

describe("reflection error message bound", () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Reflection()], interceptors: [], allowHTTP1: false });
        await server.start();
        baseUrl = `http://localhost:${server.address?.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    const transports: Record<string, () => Transport> = {
        http: () => createGrpcTransport({ baseUrl }),
        "in-process": () => createLocalTransport(server),
    };

    for (const [transportName, transport] of Object.entries(transports)) {
        for (const version of ["v1", "v1alpha"] as const) {
            describe(`${version} over ${transportName}`, () => {
                for (const kind of ["fileByFilename", "fileContainingSymbol"] as const) {
                    it(`${kind}: repeats at most ${ECHOED_NAME_LIMIT} characters of the name in error_message`, async () => {
                        const name = "n".repeat(10_000);
                        const response = await ask(transport(), version, request(version, kind, name));

                        assert.strictEqual(response.messageResponse.case, "errorResponse");
                        assert.strictEqual(response.messageResponse.value.errorCode, NOT_FOUND);
                        const message = response.messageResponse.value.errorMessage;
                        assert.ok(message.length < ECHOED_NAME_LIMIT + 64, `error_message has ${message.length} characters`);
                        assert.ok(message.includes("n".repeat(ECHOED_NAME_LIMIT)), "the first 128 characters of the name are repeated");
                        assert.ok(!message.includes("n".repeat(ECHOED_NAME_LIMIT + 1)), "nothing beyond them is");
                        assert.ok(message.includes("…"), "the cut is marked");
                    });

                    it(`${kind}: repeats a name of ${ECHOED_NAME_LIMIT} characters unchanged`, async () => {
                        const name = "n".repeat(ECHOED_NAME_LIMIT);
                        const response = await ask(transport(), version, request(version, kind, name));

                        assert.strictEqual(response.messageResponse.case, "errorResponse");
                        assert.ok(response.messageResponse.value.errorMessage.includes(`"${name}"`), response.messageResponse.value.errorMessage);
                        assert.ok(!response.messageResponse.value.errorMessage.includes("…"));
                    });
                }

                it("bounds the type name in the errors of the extension queries too", async () => {
                    const name = "t".repeat(10_000);
                    const byExtension = await ask(transport(), version, extensionRequest(version, name));
                    const byType = await ask(transport(), version, request(version, "allExtensionNumbersOfType", name));

                    for (const response of [byExtension, byType]) {
                        assert.strictEqual(response.messageResponse.case, "errorResponse");
                        assert.strictEqual(response.messageResponse.value.errorCode, NOT_FOUND);
                        const message = response.messageResponse.value.errorMessage;
                        assert.ok(message.length < ECHOED_NAME_LIMIT + 96, `error_message has ${message.length} characters`);
                        assert.ok(message.includes("t".repeat(ECHOED_NAME_LIMIT)) && !message.includes("t".repeat(ECHOED_NAME_LIMIT + 1)));
                    }
                });

                it("keeps original_request complete: it is how a client matches an answer to its question", async () => {
                    const name = "n".repeat(10_000);
                    const response = await ask(transport(), version, request(version, "fileByFilename", name));

                    assert.deepStrictEqual(response.originalRequest?.messageRequest, { case: "fileByFilename", value: name });
                });

                it("answers a 1 MiB name with a response only slightly larger than the request, not twice its size", async () => {
                    const name = "n".repeat(1024 * 1024);
                    const response = await ask(transport(), version, request(version, "fileByFilename", name));

                    const schema = version === "v1" ? ServerReflectionResponseSchema : V1alphaResponseSchema;
                    const size = toBinary(schema, response as never).length;
                    assert.ok(size > name.length, "original_request still carries the name");
                    assert.ok(size < name.length + 1024, `the response has ${size} bytes for a request of ${name.length}`);
                });

                it("does not cut a surrogate pair at the end of the echoed prefix", async () => {
                    // 127 characters, then a pair that would straddle the limit.
                    const name = `${"n".repeat(ECHOED_NAME_LIMIT - 1)}\u{1F600}${"n".repeat(50)}`;
                    const response = await ask(transport(), version, request(version, "fileByFilename", name));

                    assert.strictEqual(response.messageResponse.case, "errorResponse");
                    const message = response.messageResponse.value.errorMessage;
                    // UTF-8 encoding turns a lone surrogate into U+FFFD, so that is what a client would read.
                    assert.ok(!message.includes("�"), `a half of a surrogate pair was sent: ${JSON.stringify(message.slice(-8))}`);
                    assert.doesNotMatch(message, /[\ud800-\udbff](?![\udc00-\udfff])/, "no lone high surrogate");
                    assert.doesNotMatch(message, /(?<![\ud800-\udbff])[\udc00-\udfff]/, "no lone low surrogate");
                });
            });
        }
    }
});

// Reflection has no request limit of its own, so the server-wide one is what bounds a request.
// The README says so; this pins it, so the statement is what a client really gets.
describe("reflection request next to a server-wide readMaxBytes", () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Reflection()], interceptors: [], allowHTTP1: false, readMaxBytes: 1024 });
        await server.start();
        baseUrl = `http://localhost:${server.address?.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    it("answers a request within the limit", async () => {
        const response = await ask(createGrpcTransport({ baseUrl }), "v1", request("v1", "fileByFilename", "a".repeat(512)));
        assert.strictEqual(response.messageResponse.case, "errorResponse");
        assert.strictEqual(response.messageResponse.value.errorCode, NOT_FOUND);
    });

    it("ends a request above the limit with resource_exhausted", async () => {
        await assert.rejects(ask(createGrpcTransport({ baseUrl }), "v1", request("v1", "fileByFilename", "a".repeat(10 * 1024))), (error: unknown) => error instanceof ConnectError && error.code === Code.ResourceExhausted);
    });
});

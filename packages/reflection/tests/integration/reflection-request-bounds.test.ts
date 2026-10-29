/**
 * How much of a request a reflection response repeats, and how large a request
 * the reflection service reads.
 *
 * A reflection client sends names: a file path, a fully-qualified symbol, a
 * type. Nothing in the protocol makes them long, but nothing stopped a client
 * from sending megabytes: the server read the message, then answered with the
 * value twice, once in `error_message` and once in `original_request`.
 * `original_request` is part of the protocol (the response says which request
 * it answers) and stays complete; the message text repeats a bounded prefix,
 * and the service refuses requests no valid client sends.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, type Server } from "@connectum/core";
import { ServerReflectionRequestSchema, type ServerReflectionResponse, ServerReflection as V1 } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { ServerReflection as V1alpha, ServerReflectionRequestSchema as V1alphaRequestSchema } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";

/** Longest part of a requested name that an `error_message` repeats. */
const ECHOED_NAME_LIMIT = 128;
/** Largest request message the reflection service reads. */
const REQUEST_LIMIT_BYTES = 64 * 1024;
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

/** The name length whose request message is exactly `bytes` long. */
function nameForMessageOf(version: Version, bytes: number): string {
    let length = bytes;
    for (;;) {
        const size = toBinary(version === "v1" ? ServerReflectionRequestSchema : V1alphaRequestSchema, request(version, "fileByFilename", "a".repeat(length)) as never).length;
        if (size === bytes) {
            return "a".repeat(length);
        }
        assert.ok(size > bytes, "no name length produces a message of exactly that size");
        length -= size - bytes;
    }
}

describe("reflection request bounds", () => {
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

                it(`reads a request of exactly ${REQUEST_LIMIT_BYTES} bytes`, async () => {
                    const name = nameForMessageOf(version, REQUEST_LIMIT_BYTES);
                    const response = await ask(transport(), version, request(version, "fileByFilename", name));

                    assert.strictEqual(response.messageResponse.case, "errorResponse");
                    assert.strictEqual(response.messageResponse.value.errorCode, NOT_FOUND);
                });

                it(`refuses a request of ${REQUEST_LIMIT_BYTES + 1} bytes with resource_exhausted`, async () => {
                    const name = nameForMessageOf(version, REQUEST_LIMIT_BYTES + 1);
                    await assert.rejects(ask(transport(), version, request(version, "fileByFilename", name)), (error: unknown) => {
                        assert.ok(error instanceof ConnectError, String(error));
                        assert.strictEqual(error.code, Code.ResourceExhausted, error.message);
                        return true;
                    });
                });

                it("refuses a request of 8 MiB instead of answering with 16 MiB", async () => {
                    await assert.rejects(ask(transport(), version, request(version, "fileByFilename", "a".repeat(8 * 1024 * 1024))), (error: unknown) => {
                        assert.ok(error instanceof ConnectError, String(error));
                        assert.strictEqual(error.code, Code.ResourceExhausted, error.message);
                        return true;
                    });
                });
            });
        }
    }

    it("serves the next stream after one was refused", async () => {
        await assert.rejects(ask(createGrpcTransport({ baseUrl }), "v1", request("v1", "fileByFilename", "a".repeat(1024 * 1024))));
        const response = await ask(createGrpcTransport({ baseUrl }), "v1", request("v1", "listServices", ""));
        assert.strictEqual(response.messageResponse.case, "listServicesResponse");
    });
});

// A service's own readMaxBytes replaces the server-wide one, a smaller value included. The
// README says so; this pins it, so the statement is what a client really gets.
describe("reflection request limit next to a smaller server-wide readMaxBytes", () => {
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

    it("reads a request of 10 KiB although the server-wide limit is 1 KiB", async () => {
        const response = await ask(createGrpcTransport({ baseUrl }), "v1", request("v1", "fileByFilename", "a".repeat(10 * 1024)));
        assert.strictEqual(response.messageResponse.case, "errorResponse");
        assert.strictEqual(response.messageResponse.value.errorCode, NOT_FOUND);
    });

    it("still refuses a request beyond its own limit", async () => {
        await assert.rejects(ask(createGrpcTransport({ baseUrl }), "v1", request("v1", "fileByFilename", "a".repeat(REQUEST_LIMIT_BYTES + 1))), (error: unknown) => error instanceof ConnectError && error.code === Code.ResourceExhausted);
    });
});

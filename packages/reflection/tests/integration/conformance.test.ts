/**
 * gRPC Server Reflection protocol conformance.
 *
 * Every request kind of `grpc.reflection.v1` and `grpc.reflection.v1alpha`
 * is checked against the protocol (grpc/grpc-proto
 * `grpc/reflection/v1/reflection.proto`, grpc/grpc `doc/server-reflection.md`)
 * over both the HTTP/2 gRPC transport and the in-process transport, using a
 * fixture whose files import each other, well-known types and descriptor
 * options, and declare nested types, oneofs, map fields, enums and
 * extensions.
 *
 * Each case pins a behavior a reflection client depends on: grpcurl resolves
 * `describe pkg.Svc.Method` through `file_containing_symbol`, expects the
 * imports of a file in the same answer, and keeps reusing one stream after an
 * error.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, equals, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import {
    ServerReflectionRequestSchema,
    type ServerReflectionResponse,
    ServerReflectionResponseSchema,
    ServerReflection as ServerReflectionV1,
} from "#gen/grpc/reflection/v1/reflection_pb.js";
import {
    ServerReflection as ServerReflectionV1alpha,
    ServerReflectionRequestSchema as V1alphaRequestSchema,
    ServerReflectionResponseSchema as V1alphaResponseSchema,
} from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";
import { collectFileProtos } from "../../src/utils.ts";
import { MetaSchema } from "../fixtures/fixture/v1/common_pb.ts";
import { MountedService } from "../fixtures/fixture/v1/multi_pb.ts";
import { FixtureService, file_fixture_v1_service } from "../fixtures/fixture/v1/service_pb.ts";

type RequestInit = MessageInitShape<typeof ServerReflectionRequestSchema>;
type Version = "v1" | "v1alpha";

const NOT_FOUND = 5;
const INVALID_ARGUMENT = 3;

const SERVICE_FILE = "fixture/v1/service.proto";
const COMMON_FILE = "fixture/v1/common.proto";
const LEGACY_FILE = "fixture/v1/legacy.proto";
const OPTIONS_FILE = "fixture/v1/options.proto";

/** Every file the fixture service depends on, transitively, including itself. */
const SERVICE_CLOSURE = [
    SERVICE_FILE,
    COMMON_FILE,
    LEGACY_FILE,
    OPTIONS_FILE,
    "google/protobuf/empty.proto",
    "google/protobuf/timestamp.proto",
    "google/protobuf/descriptor.proto",
];

/** Serialized source descriptors: what the server must send for each file. */
const sourceBytes = new Map(collectFileProtos([file_fixture_v1_service]).map((proto) => [proto.name, toBinary(FileDescriptorProtoSchema, proto)]));

const fixtureService = defineService(FixtureService, {
    get: () => create(MetaSchema, {}),
    ping: () => ({}),
});

/**
 * Runs one `ServerReflectionInfo` stream carrying all `requests` and returns
 * the responses as v1 messages. v1alpha is wire-identical to v1, so its
 * messages are converted through their binary form.
 */
async function session(transport: Transport, version: Version, requests: RequestInit[]): Promise<ServerReflectionResponse[]> {
    const v1Requests = requests.map((init) => create(ServerReflectionRequestSchema, init));
    const responses: ServerReflectionResponse[] = [];
    if (version === "v1") {
        const client = createClient(ServerReflectionV1, transport);
        for await (const response of client.serverReflectionInfo(toStream(v1Requests))) {
            responses.push(response);
        }
        return responses;
    }
    const client = createClient(ServerReflectionV1alpha, transport);
    const v1alphaRequests = v1Requests.map((request) => fromBinary(V1alphaRequestSchema, toBinary(ServerReflectionRequestSchema, request)));
    for await (const response of client.serverReflectionInfo(toStream(v1alphaRequests))) {
        responses.push(fromBinary(ServerReflectionResponseSchema, toBinary(V1alphaResponseSchema, response)));
    }
    return responses;
}

async function* toStream<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) {
        yield item;
    }
}

async function single(transport: Transport, version: Version, request: RequestInit): Promise<ServerReflectionResponse> {
    const [response] = await session(transport, version, [request]);
    assert.ok(response, "expected one response");
    return response;
}

/** Names of the files in a file_descriptor_response, after checking each entry is byte-equal to its source. */
function fileNames(response: ServerReflectionResponse): string[] {
    assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse", `expected files, got ${JSON.stringify(response.messageResponse)}`);
    return response.messageResponse.value.fileDescriptorProto.map((bytes) => {
        const name = fromBinary(FileDescriptorProtoSchema, bytes).name;
        const expected = sourceBytes.get(name);
        if (expected !== undefined) {
            // Copy first: over HTTP the decoder may hand out a Node.js Buffer,
            // whose prototype alone would fail a deep comparison.
            assert.deepStrictEqual(Uint8Array.from(bytes), expected, `${name} differs from the source descriptor`);
        }
        return name;
    });
}

function assertError(response: ServerReflectionResponse, code: number, ...mentions: string[]): void {
    assert.strictEqual(response.messageResponse.case, "errorResponse", `expected an error, got ${JSON.stringify(response.messageResponse)}`);
    assert.strictEqual(response.messageResponse.value.errorCode, code);
    for (const mention of mentions) {
        assert.ok(response.messageResponse.value.errorMessage.includes(mention), `"${response.messageResponse.value.errorMessage}" should mention ${mention}`);
    }
}

describe("gRPC Server Reflection conformance", () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
        server = createServer({ services: [fixtureService], port: 0, protocols: [Healthcheck(), Reflection()], interceptors: [], allowHTTP1: false });
        await server.start();
        assert.ok(server.address?.port);
        baseUrl = `http://localhost:${server.address.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    const transports: Record<string, () => Transport> = {
        http: () => createGrpcTransport({ baseUrl }),
        "in-process": () => createLocalTransport(server),
    };

    for (const version of ["v1", "v1alpha"] as const) {
        for (const [transportName, transport] of Object.entries(transports)) {
            describe(`${version} over ${transportName}`, () => {
                it("echoes host and the original request", async () => {
                    const request = create(ServerReflectionRequestSchema, { host: "h1", messageRequest: { case: "listServices", value: "*" } });
                    const response = await single(transport(), version, request);
                    assert.strictEqual(response.validHost, "h1");
                    assert.ok(response.originalRequest && equals(ServerReflectionRequestSchema, response.originalRequest, request), "original_request must be echoed");
                });

                it("lists the mounted services only, ignoring the request content", async () => {
                    for (const value of ["", "*"]) {
                        const response = await single(transport(), version, { messageRequest: { case: "listServices", value } });
                        assert.strictEqual(response.messageResponse.case, "listServicesResponse");
                        assert.deepStrictEqual(
                            response.messageResponse.value.service.map((s) => s.name),
                            // fixture.v1.UnmountedService is declared in an imported file but never mounted.
                            ["fixture.v1.FixtureService", "grpc.health.v1.Health"],
                        );
                    }
                });

                it("answers a file with its transitive imports, then never repeats them on the stream", async () => {
                    const [first, second, third, fourth] = await session(transport(), version, [
                        { messageRequest: { case: "fileByFilename", value: SERVICE_FILE } },
                        { messageRequest: { case: "fileByFilename", value: COMMON_FILE } },
                        { messageRequest: { case: "fileContainingSymbol", value: "fixture.v1.FixtureService" } },
                        { messageRequest: { case: "fileByFilename", value: "grpc/health/v1/health.proto" } },
                    ]);
                    assert.ok(first && second && third && fourth);
                    const closure = fileNames(first);
                    assert.strictEqual(closure[0], SERVICE_FILE, "the requested file comes first");
                    assert.deepStrictEqual([...closure].sort(), [...SERVICE_CLOSURE].sort());
                    assert.strictEqual(new Set(closure).size, closure.length, "no file twice in one answer");
                    // Already sent: only the requested file itself comes back.
                    assert.deepStrictEqual(fileNames(second), [COMMON_FILE]);
                    assert.deepStrictEqual(fileNames(third), [SERVICE_FILE]);
                    assert.deepStrictEqual(fileNames(fourth), ["grpc/health/v1/health.proto"]);
                });

                it("starts every stream with an empty 'already sent' set", async () => {
                    await session(transport(), version, [{ messageRequest: { case: "fileByFilename", value: SERVICE_FILE } }]);
                    const response = await single(transport(), version, { messageRequest: { case: "fileByFilename", value: COMMON_FILE } });
                    assert.deepStrictEqual(fileNames(response).sort(), [COMMON_FILE, "google/protobuf/empty.proto", "google/protobuf/timestamp.proto"].sort());
                });

                it("resolves every kind of named declaration to its file", async () => {
                    const symbols: Array<[symbol: string, file: string]> = [
                        ["fixture.v1.FixtureService", SERVICE_FILE],
                        ["fixture.v1.FixtureService.Get", SERVICE_FILE],
                        ["fixture.v1.GetRequest", SERVICE_FILE],
                        ["fixture.v1.GetRequest.id", SERVICE_FILE],
                        ["fixture.v1.GetRequest.key", SERVICE_FILE],
                        ["fixture.v1.Meta", COMMON_FILE],
                        ["fixture.v1.Meta.Note", COMMON_FILE],
                        ["fixture.v1.Meta.labels", COMMON_FILE],
                        ["fixture.v1.Meta.LabelsEntry", COMMON_FILE],
                        ["fixture.v1.Level", COMMON_FILE],
                        // Enum values are siblings of their enum, not children.
                        ["fixture.v1.LEVEL_HIGH", COMMON_FILE],
                        ["fixture.v1.Meta.State", COMMON_FILE],
                        ["fixture.v1.Meta.STATE_OPEN", COMMON_FILE],
                        ["fixture.v1.UnmountedService.Noop", COMMON_FILE],
                        ["fixture.v1.audit", OPTIONS_FILE],
                        ["fixture.v1.top_ext", LEGACY_FILE],
                        ["fixture.v1.Scope.nested_ext", LEGACY_FILE],
                        ["google.protobuf.Timestamp", "google/protobuf/timestamp.proto"],
                        ["grpc.health.v1.Health", "grpc/health/v1/health.proto"],
                    ];
                    const responses = await session(
                        transport(),
                        version,
                        symbols.map(([value]) => ({ messageRequest: { case: "fileContainingSymbol", value } })),
                    );
                    assert.strictEqual(responses.length, symbols.length);
                    symbols.forEach(([symbol, file], index) => {
                        const response = responses[index];
                        assert.ok(response);
                        assert.strictEqual(fileNames(response)[0], file, `${symbol} is declared in ${file}`);
                    });
                });

                it("answers NOT_FOUND for an unknown symbol or file", async () => {
                    const unknown = ["no.such.Symbol", "fixture.v1.Level.LEVEL_HIGH", "fixture.v1", ""];
                    const responses = await session(transport(), version, [
                        ...unknown.map((value): RequestInit => ({ messageRequest: { case: "fileContainingSymbol", value } })),
                        { messageRequest: { case: "fileByFilename", value: "nope.proto" } },
                    ]);
                    unknown.forEach((symbol, index) => {
                        const response = responses[index];
                        assert.ok(response);
                        assertError(response, NOT_FOUND, symbol);
                    });
                    const fileResponse = responses[unknown.length];
                    assert.ok(fileResponse);
                    assertError(fileResponse, NOT_FOUND, "nope.proto");
                });

                it("finds the file of an extension by containing type and number", async () => {
                    const cases: Array<[containingType: string, extensionNumber: number, file: string]> = [
                        ["google.protobuf.MethodOptions", 50001, OPTIONS_FILE],
                        ["fixture.v1.Extendable", 100, LEGACY_FILE],
                        ["fixture.v1.Extendable", 101, LEGACY_FILE],
                    ];
                    const responses = await session(
                        transport(),
                        version,
                        cases.map(([containingType, extensionNumber]) => ({
                            messageRequest: { case: "fileContainingExtension", value: { containingType, extensionNumber } },
                        })),
                    );
                    cases.forEach(([containingType, extensionNumber, file], index) => {
                        const response = responses[index];
                        assert.ok(response);
                        assert.strictEqual(fileNames(response)[0], file, `${containingType}#${extensionNumber}`);
                    });
                });

                it("answers NOT_FOUND for an unknown extension, naming the type and number", async () => {
                    const [unknownNumber, unknownType] = await session(transport(), version, [
                        { messageRequest: { case: "fileContainingExtension", value: { containingType: "fixture.v1.Extendable", extensionNumber: 150 } } },
                        { messageRequest: { case: "fileContainingExtension", value: { containingType: "no.such.Type", extensionNumber: 1 } } },
                    ]);
                    assert.ok(unknownNumber && unknownType);
                    assertError(unknownNumber, NOT_FOUND, "fixture.v1.Extendable", "150");
                    assertError(unknownType, NOT_FOUND, "no.such.Type");
                });

                it("lists extension numbers with the base type name, in ascending order", async () => {
                    const cases: Array<[type: string, numbers: number[]]> = [
                        ["fixture.v1.Extendable", [100, 101]],
                        ["google.protobuf.MethodOptions", [50001]],
                        ["fixture.v1.Meta", []],
                    ];
                    const responses = await session(
                        transport(),
                        version,
                        cases.map(([value]) => ({ messageRequest: { case: "allExtensionNumbersOfType", value } })),
                    );
                    cases.forEach(([type, numbers], index) => {
                        const response = responses[index];
                        assert.ok(response);
                        assert.strictEqual(response.messageResponse.case, "allExtensionNumbersResponse", `${type}: ${JSON.stringify(response.messageResponse)}`);
                        assert.strictEqual(response.messageResponse.value.baseTypeName, type);
                        assert.deepStrictEqual(response.messageResponse.value.extensionNumber, numbers);
                    });
                });

                it("answers NOT_FOUND for extension numbers of an unknown or non-message type", async () => {
                    const responses = await session(transport(), version, [
                        { messageRequest: { case: "allExtensionNumbersOfType", value: "no.such.Type" } },
                        { messageRequest: { case: "allExtensionNumbersOfType", value: "fixture.v1.Level" } },
                    ]);
                    assertError(responses[0] as ServerReflectionResponse, NOT_FOUND, "no.such.Type");
                    assertError(responses[1] as ServerReflectionResponse, NOT_FOUND, "fixture.v1.Level");
                });

                it("answers INVALID_ARGUMENT for a request without a query and keeps the stream open", async () => {
                    const [empty, list] = await session(transport(), version, [{}, { messageRequest: { case: "listServices", value: "" } }]);
                    assert.ok(empty && list);
                    assertError(empty, INVALID_ARGUMENT);
                    assert.strictEqual(list.messageResponse.case, "listServicesResponse");
                });

                it("answers several mixed requests on one stream in order", async () => {
                    const responses = await session(transport(), version, [
                        { messageRequest: { case: "listServices", value: "" } },
                        { messageRequest: { case: "fileByFilename", value: "nope.proto" } },
                        { messageRequest: { case: "fileContainingSymbol", value: "fixture.v1.FixtureService" } },
                    ]);
                    assert.deepStrictEqual(
                        responses.map((r) => r.messageResponse.case),
                        ["listServicesResponse", "errorResponse", "fileDescriptorResponse"],
                    );
                });
            });
        }
    }

    it("v1 and v1alpha answer the same request sequence identically", async () => {
        const requests: RequestInit[] = [
            { host: "h", messageRequest: { case: "listServices", value: "" } },
            { messageRequest: { case: "fileContainingSymbol", value: "fixture.v1.FixtureService.Get" } },
            { messageRequest: { case: "fileContainingExtension", value: { containingType: "fixture.v1.Extendable", extensionNumber: 150 } } },
            { messageRequest: { case: "allExtensionNumbersOfType", value: "fixture.v1.Extendable" } },
            {},
        ];
        const transport = createGrpcTransport({ baseUrl });
        const v1 = await session(transport, "v1", requests);
        const v1alpha = await session(transport, "v1alpha", requests);
        assert.deepStrictEqual(
            v1alpha.map((r) => toBinary(ServerReflectionResponseSchema, r)),
            v1.map((r) => toBinary(ServerReflectionResponseSchema, r)),
        );
    });
});

// A file that declares two services, of which only one is mounted: the
// listing must follow what is mounted, not what the mounted file declares.
// Both services' file is still served, so the unmounted one resolves as a
// symbol — it is a declaration, just not a served service.
describe("gRPC Server Reflection with a partly mounted file", () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
        const mounted = defineService(MountedService, { ping: () => ({}) });
        server = createServer({ services: [mounted], port: 0, protocols: [Reflection()], interceptors: [], allowHTTP1: false });
        await server.start();
        assert.ok(server.address?.port);
        baseUrl = `http://localhost:${server.address.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    const transports: Record<string, () => Transport> = {
        http: () => createGrpcTransport({ baseUrl }),
        "in-process": () => createLocalTransport(server),
    };

    for (const version of ["v1", "v1alpha"] as const) {
        for (const [transportName, transport] of Object.entries(transports)) {
            it(`${version} over ${transportName} lists only the mounted service of the file`, async () => {
                const [list, peer] = await session(transport(), version, [
                    { messageRequest: { case: "listServices", value: "" } },
                    { messageRequest: { case: "fileContainingSymbol", value: "fixture.v1.UnmountedPeerService" } },
                ]);
                assert.ok(list && peer);
                assert.strictEqual(list.messageResponse.case, "listServicesResponse");
                assert.deepStrictEqual(
                    list.messageResponse.value.service.map((s) => s.name),
                    ["fixture.v1.MountedService"],
                );
                assert.strictEqual(fileNames(peer)[0], "fixture/v1/multi.proto");
            });
        }
    }
});

/**
 * Group 8 — gRPC Server Reflection parity.
 *
 *   8.1 one bidi reflection stream carrying every request kind
 *   8.2 the reflection service describes itself by symbol, and stays out of the listing
 *   8.3 an unknown name is echoed in a bounded error message
 *
 * Reflection is a protocol registered by `@connectum/reflection`, not a user
 * service, and it keeps per-stream state (files already sent). The scenario
 * runs one long stream over each transport, so a difference in the listing,
 * in the import closure, in the "already sent" bookkeeping or in an error
 * answer shows up as a structural diff. Each answer is also checked against the
 * gRPC Server Reflection protocol itself (one response per request, in order,
 * echoing host and request; NOT_FOUND for unknown names; INVALID_ARGUMENT for a
 * request without a query; the requested file first, then its imports not yet
 * sent), so two transports that agree on a wrong answer still fail.
 */

import assert from "node:assert";
import { create, fromBinary, type MessageInitShape, type MessageShape, toJson } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { type Client, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import { ServerReflection, ServerReflectionRequestSchema, ServerReflectionResponseSchema } from "../../../reflection/gen/grpc/reflection/v1/reflection_pb.js";
import { MetaSchema } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { defaultCompare, transportParityTest } from "../../src/transportParityTest.ts";

type ReflectionResponse = MessageShape<typeof ServerReflectionResponseSchema>;

const fixtureService = defineService(FixtureService, {
    get: () => create(MetaSchema, {}),
    ping: () => ({}),
});

const requests = [
    { host: "h1", messageRequest: { case: "listServices" as const, value: "" } },
    { messageRequest: { case: "fileByFilename" as const, value: "fixture/v1/service.proto" } },
    // Every import was sent by the previous answer: only the file comes back.
    { messageRequest: { case: "fileContainingSymbol" as const, value: "fixture.v1.FixtureService.Get" } },
    { messageRequest: { case: "fileContainingExtension" as const, value: { containingType: "google.protobuf.MethodOptions", extensionNumber: 50001 } } },
    { messageRequest: { case: "allExtensionNumbersOfType" as const, value: "fixture.v1.Extendable" } },
    { messageRequest: { case: "fileContainingSymbol" as const, value: "no.such.Symbol" } },
    {},
    { messageRequest: { case: "fileByFilename" as const, value: "grpc/health/v1/health.proto" } },
].map((init) => create(ServerReflectionRequestSchema, init));

/** The file names of a `file_descriptor_response`, in the order the server sent them. */
function fileNames(response: ReflectionResponse): string[] {
    assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse", "expected a file_descriptor_response");
    return response.messageResponse.value.fileDescriptorProto.map((bytes) => fromBinary(FileDescriptorProtoSchema, bytes).name);
}

/** Every transitive dependency of a file, by name, taken from the descriptors the fixture was generated with. */
function transitiveDependencyNames(file: typeof FixtureService.file): string[] {
    const names = new Set<string>();
    const visit = (f: typeof FixtureService.file) => {
        for (const dep of f.dependencies) {
            if (!names.has(dep.proto.name)) {
                names.add(dep.proto.name);
                visit(dep);
            }
        }
    };
    visit(file);
    return [...names];
}

// 8.1
transportParityTest("parity 8.1: a reflection stream answers identically", {
    services: [fixtureService],
    protocols: [Healthcheck(), Reflection()],
    scenario: async ({ transport }) => {
        const client = createClient(ServerReflection, transport);
        async function* send() {
            yield* requests;
        }
        const raw: ReflectionResponse[] = [];
        for await (const response of client.serverReflectionInfo(send())) {
            raw.push(response);
        }
        // Two equally truncated streams would still compare equal.
        if (raw.length !== requests.length) {
            throw new Error(`expected ${requests.length} responses, got ${raw.length}`);
        }
        return {
            response: {
                json: raw.map((response) => toJson(ServerReflectionResponseSchema, response)),
                // Reduced to the facts the protocol fixes, so they can be asserted without
                // depending on the serialized descriptor bytes.
                answers: raw.map((response) => ({
                    validHost: response.validHost,
                    originalRequestCase: response.originalRequest?.messageRequest.case ?? null,
                    kind: response.messageResponse.case ?? null,
                })),
                services: response0Services(raw),
                files: { service: fileNames(raw[1] as (typeof raw)[number]), symbol: fileNames(raw[2] as (typeof raw)[number]), extension: fileNames(raw[3] as (typeof raw)[number]), health: fileNames(raw[7] as (typeof raw)[number]) },
                extensionNumbers: raw[4]?.messageResponse.case === "allExtensionNumbersResponse" ? { type: raw[4].messageResponse.value.baseTypeName, numbers: raw[4].messageResponse.value.extensionNumber } : null,
                errors: { unknownSymbol: errorOf(raw[5]), emptyRequest: errorOf(raw[6]) },
            },
        };
    },
    compare: (http, local) => {
        const dependencies = transitiveDependencyNames(FixtureService.file);
        const expectedKinds = [
            "listServicesResponse",
            "fileDescriptorResponse",
            "fileDescriptorResponse",
            "fileDescriptorResponse",
            "allExtensionNumbersResponse",
            "errorResponse",
            "errorResponse",
            "fileDescriptorResponse",
        ];
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            const r = result.response as {
                answers: { validHost: string; originalRequestCase: string | null; kind: string | null }[];
                services: string[];
                files: Record<"service" | "symbol" | "extension" | "health", string[]>;
                extensionNumbers: { type: string; numbers: number[] } | null;
                errors: { unknownSymbol: { code: number; message: string } | null; emptyRequest: { code: number; message: string } | null };
            };
            const expectedRequestCases = requests.map((request) => request.messageRequest.case ?? null);
            assert.deepStrictEqual(
                r.answers.map((a) => a.kind),
                expectedKinds,
                `${name}: one response per request, in request order, of the kind the request asks for`,
            );
            assert.deepStrictEqual(
                r.answers.map((a) => a.originalRequestCase),
                expectedRequestCases,
                `${name}: every response echoes the request it answers`,
            );
            assert.deepStrictEqual(
                r.answers.map((a) => a.validHost),
                requests.map((request) => request.host),
                `${name}: every response echoes the request's host`,
            );
            assert.deepStrictEqual(r.services, ["fixture.v1.FixtureService", "grpc.health.v1.Health"], `${name}: list_services names the mounted services in registration order`);
            assert.strictEqual(r.files.service[0], "fixture/v1/service.proto", `${name}: the requested file comes first`);
            assert.deepStrictEqual([...r.files.service.slice(1)].sort(), [...dependencies].sort(), `${name}: the requested file is followed by each transitive import exactly once`);
            assert.deepStrictEqual(r.files.symbol, ["fixture/v1/service.proto"], `${name}: imports already sent on the stream are not repeated`);
            assert.deepStrictEqual(r.files.extension, ["fixture/v1/options.proto"], `${name}: the extension's file is returned, its imports having been sent already`);
            assert.strictEqual(r.files.health[0], "grpc/health/v1/health.proto", `${name}: the requested file comes first`);
            assert.deepStrictEqual(r.extensionNumbers, { type: "fixture.v1.Extendable", numbers: [100, 101] }, `${name}: extension numbers of the type, ascending`);
            assert.strictEqual(r.errors.unknownSymbol?.code, 5, `${name}: an unknown symbol is NOT_FOUND`);
            assert.ok(r.errors.unknownSymbol?.message.includes("no.such.Symbol"), `${name}: the error names the symbol`);
            assert.strictEqual(r.errors.emptyRequest?.code, 3, `${name}: a request without a query is INVALID_ARGUMENT`);
        }
        defaultCompare(http, local);
    },
});

/** One request on a fresh stream; the single response, or the error that ended the stream. */
async function askOnce(client: Client<typeof ServerReflection>, messageRequest: NonNullable<MessageInitShape<typeof ServerReflectionRequestSchema>["messageRequest"]>): Promise<ReflectionResponse> {
    async function* send() {
        yield create(ServerReflectionRequestSchema, { messageRequest });
    }
    for await (const response of client.serverReflectionInfo(send())) {
        return response;
    }
    throw new Error("the reflection stream ended without a response");
}

// 8.2
transportParityTest("parity 8.2: the reflection service describes itself by symbol and stays out of the listing", {
    services: [fixtureService],
    protocols: [Healthcheck(), Reflection()],
    scenario: async ({ transport }) => {
        const client = createClient(ServerReflection, transport);
        const own = await askOnce(client, { case: "fileContainingSymbol", value: "grpc.reflection.v1.ServerReflection" });
        const alpha = await askOnce(client, { case: "fileContainingSymbol", value: "grpc.reflection.v1alpha.ServerReflection" });
        const listing = await askOnce(client, { case: "listServices", value: "" });
        return {
            response: {
                own: own.messageResponse.case === "fileDescriptorResponse" ? own.messageResponse.value.fileDescriptorProto.map((bytes) => fromBinary(FileDescriptorProtoSchema, bytes).name) : own.messageResponse.case,
                alpha: alpha.messageResponse.case === "fileDescriptorResponse" ? alpha.messageResponse.value.fileDescriptorProto.map((bytes) => fromBinary(FileDescriptorProtoSchema, bytes).name) : alpha.messageResponse.case,
                listed: listing.messageResponse.case === "listServicesResponse" ? listing.messageResponse.value.service.map((s) => s.name) : listing.messageResponse.case,
            },
        };
    },
    compare: (http, local) => {
        const expected = {
            own: ["grpc/reflection/v1/reflection.proto"],
            alpha: ["grpc/reflection/v1alpha/reflection.proto"],
            listed: ["fixture.v1.FixtureService", "grpc.health.v1.Health"],
        };
        assert.deepStrictEqual(http.response, expected, "HTTP transport result");
        assert.deepStrictEqual(local.response, expected, "Local transport result");
        defaultCompare(http, local);
    },
});

// 8.3
transportParityTest("parity 8.3: an unknown name is echoed in a bounded message", {
    services: [],
    protocols: [Reflection()],
    scenario: async ({ transport }) => {
        const client = createClient(ServerReflection, transport);
        const unknown = await askOnce(client, { case: "fileByFilename", value: "x".repeat(10_000) });
        const echoed = unknown.originalRequest?.messageRequest;
        return {
            response: {
                errorMessage: unknown.messageResponse.case === "errorResponse" ? unknown.messageResponse.value.errorMessage : null,
                echoedLength: echoed?.case === "fileByFilename" ? echoed.value.length : null,
            },
        };
    },
    compare: (http, local) => {
        // error_message repeats 128 characters; original_request still carries all 10000.
        const expected = { errorMessage: `file not found: "${"x".repeat(128)}…"`, echoedLength: 10_000 };
        assert.deepStrictEqual(http.response, expected, "HTTP transport result");
        assert.deepStrictEqual(local.response, expected, "Local transport result");
        defaultCompare(http, local);
    },
});

function response0Services(raw: ReflectionResponse[]): string[] {
    const first = raw[0]?.messageResponse;
    return first?.case === "listServicesResponse" ? first.value.service.map((s) => s.name) : [];
}

function errorOf(response: ReflectionResponse | undefined): { code: number; message: string } | null {
    return response?.messageResponse.case === "errorResponse" ? { code: response.messageResponse.value.errorCode, message: response.messageResponse.value.errorMessage } : null;
}

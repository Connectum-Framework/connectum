/**
 * gRPC Server Reflection, checked by clients that are not built on Connect.
 *
 * grpcurl (grpc-go) and `buf curl` are what people point at a server, and they
 * are strict where our own Connect client is lenient: grpcurl resolves
 * `describe pkg.Svc.Method` through file_containing_symbol, both expect the
 * imports of a file in the same answer, and both build request and response
 * codecs only from what reflection returns. The second half of the suite sends
 * raw ServerReflectionInfo exchanges with grpcurl, using the upstream
 * `reflection.proto` from grpc/grpc-proto rather than anything generated here,
 * and compares each field of every response with what the protocol and the
 * reflection spec require.
 *
 * Not part of `pnpm test`: it needs Docker and the tools image. Run from the
 * repository root, then from this package:
 *
 *     node scripts/interop-tools.mjs
 *     pnpm test:interop
 *
 * The clients reach the server through the host network, which Docker offers
 * on Linux only; grpc_health_probe in the image is a linux-amd64 binary.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer, defineService, type Server } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { Healthcheck } from "@connectum/healthcheck";
import { readFileDescriptor } from "../../../../tests/interop/descriptors.ts";
import { PROTO_DIR, parseJsonStream, runTool, type ToolResult } from "../../../../tests/interop/tools.ts";
import { Reflection } from "../../src/Reflection.ts";
import { Level, MetaSchema } from "../fixtures/fixture/v1/common_pb.ts";
import { MountedService } from "../fixtures/fixture/v1/multi_pb.ts";
import { FixtureService } from "../fixtures/fixture/v1/service_pb.ts";

const fixtureService = defineService(FixtureService, {
    get: (request) =>
        create(MetaSchema, {
            level: Level.HIGH,
            labels: { key: request.key.case === "id" ? request.key.value : "none" },
        }),
    ping: () => ({}),
});

// `multi.proto` also declares `UnmountedPeerService`; mounting only this one
// checks that reflection lists mounted services, not every service of a file.
const mountedService = defineService(MountedService, { ping: () => ({}) });

/** Services in registration order: application services, then Healthcheck's. */
const MOUNTED = ["fixture.v1.FixtureService", "fixture.v1.MountedService", "grpc.health.v1.Health"];

interface ReflectionResponse {
    validHost?: string;
    originalRequest?: Record<string, unknown>;
    listServicesResponse?: { service: { name: string }[] };
    fileDescriptorResponse?: { fileDescriptorProto: string[] };
    allExtensionNumbersResponse?: { baseTypeName: string; extensionNumber: number[] };
    errorResponse?: { errorCode: number; errorMessage: string };
}

/**
 * File names of a `file_descriptor_response`, in the order they were sent,
 * read with the hand-written wire reader rather than with protobuf-es, the
 * library the server is built on.
 */
function filesOf(response: ReflectionResponse | undefined): string[] {
    assert.ok(response?.fileDescriptorResponse, `expected a file_descriptor_response, got ${JSON.stringify(response)}`);
    return response.fileDescriptorResponse.fileDescriptorProto.map((base64) => readFileDescriptor(Buffer.from(base64, "base64")).name);
}

describe("reflection with external clients", () => {
    let server: Server;
    let address: string;

    before(async () => {
        server = createServer({
            services: [fixtureService, mountedService],
            port: 0,
            protocols: [Healthcheck(), Reflection()],
            interceptors: [],
            allowHTTP1: false,
        });
        await server.start();
        assert.ok(server.address?.port);
        address = `127.0.0.1:${server.address.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    function assertSucceeded(result: ToolResult, what: string): void {
        assert.strictEqual(result.code, 0, `${what} exited with ${result.code}: ${result.stderr}`);
    }

    async function grpcurl(...args: string[]): Promise<string> {
        const result = await runTool("grpcurl", ["-plaintext", ...args]);
        assertSucceeded(result, `grpcurl ${args.join(" ")}`);
        return result.stdout;
    }

    async function bufCurl(...args: string[]): Promise<string> {
        const result = await runTool("buf", ["curl", "--protocol", "grpc", "--http2-prior-knowledge", ...args]);
        assertSucceeded(result, `buf curl ${args.join(" ")}`);
        return result.stdout;
    }

    describe("grpcurl", () => {
        it("lists the mounted services and no others", async () => {
            const listed = (await grpcurl(address, "list")).trim().split("\n");
            assert.deepStrictEqual([...listed].sort(), [...MOUNTED].sort());
        });

        it("describes a service, including a custom method option", async () => {
            const output = await grpcurl(address, "describe", "fixture.v1.FixtureService");
            assert.match(output, /fixture\.v1\.FixtureService is a service:/);
            assert.match(output, /rpc Get \( \.fixture\.v1\.GetRequest \) returns \( \.fixture\.v1\.Meta \)/);
            // grpcurl prints the option with its fully-qualified, dot-prefixed name.
            assert.match(output, /option \(\.fixture\.v1\.audit\) = "read";/);
        });

        // Every kind of declaration the reflection spec says file_containing_symbol
        // resolves; grpcurl names the kind in the first line of `describe`. An
        // enum value is looked up by its protobuf scope (the enum's parent), but
        // grpcurl prints it under the enum itself.
        const symbols: [symbol: string, kind: string, printedAs?: string][] = [
            ["fixture.v1.FixtureService.Get", "a method"],
            ["fixture.v1.GetRequest", "a message"],
            ["fixture.v1.Meta.Note", "a message"],
            ["fixture.v1.Meta.labels", "a field"],
            ["fixture.v1.GetRequest.key", "a one-of"],
            ["fixture.v1.Level", "an enum"],
            ["fixture.v1.Meta.State", "an enum"],
            ["fixture.v1.LEVEL_HIGH", "an enum value", "fixture.v1.Level.LEVEL_HIGH"],
            ["fixture.v1.Meta.STATE_OPEN", "an enum value", "fixture.v1.Meta.State.STATE_OPEN"],
            ["fixture.v1.top_ext", "an extension"],
            ["fixture.v1.Scope.nested_ext", "an extension"],
            ["fixture.v1.audit", "an extension"],
        ];
        for (const [symbol, kind, printedAs = symbol] of symbols) {
            it(`describes ${symbol} as ${kind}`, async () => {
                const output = await grpcurl(address, "describe", symbol);
                assert.strictEqual(output.split("\n")[0], `${printedAs} is ${kind}:`);
            });
        }

        it("calls a method using only reflection for the schema", async () => {
            const output = await grpcurl("-d", '{"id":"x"}', address, "fixture.v1.FixtureService/Get");
            assert.deepStrictEqual(JSON.parse(output), { labels: { key: "x" }, level: "LEVEL_HIGH" });
        });

        it("reports the health of mounted services only", async () => {
            const listed = JSON.parse(await grpcurl(address, "grpc.health.v1.Health/List")) as { statuses: Record<string, unknown> };
            assert.deepStrictEqual(Object.keys(listed.statuses).sort(), ["fixture.v1.FixtureService", "fixture.v1.MountedService"]);
            const unmounted = await runTool("grpcurl", ["-plaintext", "-d", '{"service":"fixture.v1.UnmountedPeerService"}', address, "grpc.health.v1.Health/Check"]);
            assert.notStrictEqual(unmounted.code, 0, "Check for a service that is declared but not mounted must fail");
            assert.match(unmounted.stderr, /Code: NotFound/);
        });
    });

    describe("buf curl", () => {
        it("lists the methods of the mounted services", async () => {
            const methods = (await bufCurl("--list-methods", `http://${address}`)).trim().split("\n");
            assert.deepStrictEqual(methods.sort(), [
                "fixture.v1.FixtureService/Get",
                "fixture.v1.FixtureService/Ping",
                "fixture.v1.MountedService/Ping",
                "grpc.health.v1.Health/Check",
                "grpc.health.v1.Health/List",
                "grpc.health.v1.Health/Watch",
            ]);
        });

        it("calls a method using only reflection for the schema", async () => {
            const output = await bufCurl("-d", '{"id":"y"}', `http://${address}/fixture.v1.FixtureService/Get`);
            assert.deepStrictEqual(JSON.parse(output), { labels: { key: "y" }, level: "LEVEL_HIGH" });
        });
    });

    for (const version of ["v1", "v1alpha"] as const) {
        describe(`raw ServerReflectionInfo exchanges (grpc.reflection.${version}, upstream schema)`, () => {
            /**
             * Send `requests` on one stream and return the parsed responses. The
             * stream must end with status OK: grpcurl exits 0 and prints no error.
             */
            async function exchange(requests: Record<string, unknown>[]): Promise<ReflectionResponse[]> {
                const result = await runTool(
                    "grpcurl",
                    [
                        "-plaintext",
                        "-import-path",
                        PROTO_DIR,
                        "-proto",
                        `grpc/reflection/${version}/reflection.proto`,
                        "-d",
                        "@",
                        address,
                        `grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`,
                    ],
                    { stdin: requests.map((request) => JSON.stringify(request)).join("\n") },
                );
                assertSucceeded(result, "the reflection stream");
                assert.strictEqual(result.stderr, "", "the stream must end without an error status");
                const responses = parseJsonStream(result.stdout) as ReflectionResponse[];
                assert.strictEqual(responses.length, requests.length, "exactly one response per request");
                return responses;
            }

            it("echoes each request and its host, answers in order, and keeps the stream open after an error", async () => {
                const requests = [
                    { host: "h1", listServices: "" },
                    { host: "h2", fileByFilename: "nope.proto" },
                    { host: "h3", fileContainingSymbol: "fixture.v1.FixtureService" },
                ];
                const [listed, missing, found] = await exchange(requests);

                for (const [index, response] of [listed, missing, found].entries()) {
                    assert.strictEqual(response?.validHost, requests[index]?.host, `valid_host of response ${index}`);
                    assert.deepStrictEqual(response?.originalRequest, requests[index], `original_request of response ${index}`);
                }
                assert.deepStrictEqual(
                    listed?.listServicesResponse?.service.map((service) => service.name),
                    MOUNTED,
                    "list_services returns the mounted services in registration order",
                );
                assert.strictEqual(missing?.errorResponse?.errorCode, 5);
                assert.match(missing?.errorResponse?.errorMessage ?? "", /nope\.proto/);
                assert.strictEqual(filesOf(found)[0], "fixture/v1/service.proto", "the stream still answers after an error_response");
            });

            it("sends a file with its transitive imports once per stream", async () => {
                const [first, second] = await exchange([{ fileByFilename: "fixture/v1/service.proto" }, { fileByFilename: "fixture/v1/common.proto" }]);
                const files = filesOf(first);
                assert.strictEqual(files[0], "fixture/v1/service.proto", "the requested file comes first");
                assert.deepStrictEqual(
                    [...files.slice(1)].sort(),
                    [
                        "fixture/v1/common.proto",
                        "fixture/v1/legacy.proto",
                        "fixture/v1/options.proto",
                        "google/protobuf/descriptor.proto",
                        "google/protobuf/empty.proto",
                        "google/protobuf/timestamp.proto",
                    ],
                    "every transitive import, well-known types included, exactly once",
                );
                assert.deepStrictEqual(filesOf(second), ["fixture/v1/common.proto"], "a file whose imports were already sent comes alone");
            });

            it("resolves every kind of declaration to the file that declares it", async () => {
                const expected: [symbol: string, file: string][] = [
                    ["fixture.v1.FixtureService", "fixture/v1/service.proto"],
                    ["fixture.v1.FixtureService.Get", "fixture/v1/service.proto"],
                    ["fixture.v1.GetRequest", "fixture/v1/service.proto"],
                    ["fixture.v1.GetRequest.key", "fixture/v1/service.proto"],
                    ["fixture.v1.GetRequest.id", "fixture/v1/service.proto"],
                    ["fixture.v1.Meta", "fixture/v1/common.proto"],
                    ["fixture.v1.Meta.Note", "fixture/v1/common.proto"],
                    ["fixture.v1.Meta.labels", "fixture/v1/common.proto"],
                    ["fixture.v1.Level", "fixture/v1/common.proto"],
                    ["fixture.v1.LEVEL_HIGH", "fixture/v1/common.proto"],
                    ["fixture.v1.Meta.State", "fixture/v1/common.proto"],
                    ["fixture.v1.Meta.STATE_OPEN", "fixture/v1/common.proto"],
                    ["fixture.v1.top_ext", "fixture/v1/legacy.proto"],
                    ["fixture.v1.Scope.nested_ext", "fixture/v1/legacy.proto"],
                    ["fixture.v1.audit", "fixture/v1/options.proto"],
                    ["fixture.v1.UnmountedPeerService", "fixture/v1/multi.proto"],
                    ["fixture.v1.UnmountedPeerService.Chat", "fixture/v1/multi.proto"],
                ];
                const responses = await exchange([...expected.map(([symbol]) => ({ fileContainingSymbol: symbol })), { fileContainingSymbol: "no.such.Symbol" }]);
                for (const [index, [symbol, file]] of expected.entries()) {
                    assert.strictEqual(filesOf(responses[index])[0], file, `file_containing_symbol ${symbol}`);
                }
                const unknown = responses.at(-1);
                assert.strictEqual(unknown?.errorResponse?.errorCode, 5);
                assert.match(unknown?.errorResponse?.errorMessage ?? "", /no\.such\.Symbol/);
            });

            it("answers extension queries", async () => {
                const [byNumber, nested, numbers, unknownType] = await exchange([
                    { fileContainingExtension: { containingType: "google.protobuf.MethodOptions", extensionNumber: 50001 } },
                    { fileContainingExtension: { containingType: "fixture.v1.Extendable", extensionNumber: 101 } },
                    { allExtensionNumbersOfType: "fixture.v1.Extendable" },
                    { allExtensionNumbersOfType: "no.such.Type" },
                ]);
                assert.strictEqual(filesOf(byNumber)[0], "fixture/v1/options.proto");
                assert.strictEqual(filesOf(nested)[0], "fixture/v1/legacy.proto");
                assert.deepStrictEqual(numbers?.allExtensionNumbersResponse, { baseTypeName: "fixture.v1.Extendable", extensionNumber: [100, 101] });
                assert.strictEqual(unknownType?.errorResponse?.errorCode, 5);
            });

            it("rejects a request without a query and keeps serving the stream", async () => {
                const [empty, listed] = await exchange([{}, { listServices: "" }]);
                assert.strictEqual(empty?.errorResponse?.errorCode, 3);
                assert.deepStrictEqual(
                    listed?.listServicesResponse?.service.map((service) => service.name),
                    MOUNTED,
                );
            });
        });
    }

    it("answers v1 and v1alpha identically for the same requests", async () => {
        const requests = [
            { host: "h", listServices: "" },
            { fileByFilename: "fixture/v1/service.proto" },
            { fileContainingSymbol: "fixture.v1.Meta.STATE_OPEN" },
            { fileContainingExtension: { containingType: "fixture.v1.Extendable", extensionNumber: 100 } },
            { allExtensionNumbersOfType: "fixture.v1.Extendable" },
            { fileByFilename: "nope.proto" },
            {},
        ];
        const stdin = requests.map((request) => JSON.stringify(request)).join("\n");
        const [v1, v1alpha] = await Promise.all(
            (["v1", "v1alpha"] as const).map(async (version) => {
                const result = await runTool(
                    "grpcurl",
                    [
                        "-plaintext",
                        "-import-path",
                        PROTO_DIR,
                        "-proto",
                        `grpc/reflection/${version}/reflection.proto`,
                        "-d",
                        "@",
                        address,
                        `grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`,
                    ],
                    { stdin },
                );
                assertSucceeded(result, `the ${version} stream`);
                return parseJsonStream(result.stdout);
            }),
        );
        assert.strictEqual(v1?.length, requests.length);
        assert.deepStrictEqual(v1alpha, v1);
    });
});

/**
 * Pins the output of the CLI reflection client.
 *
 * `connectum proto sync` turns these results into generated code, so the
 * service list, the order of the files (every file after its imports) and the
 * exact FileDescriptorSet bytes are part of its observable behavior. The file
 * order and the descriptor-set hash were recorded from the previous client
 * (`@lambdalisue/connectrpc-grpcreflect`) against this same fixture, so a
 * rewrite of the client cannot silently reorder or drop files. The service
 * list is the server's: it no longer includes `fixture.v1.UnmountedService`,
 * which is declared in an imported file but never mounted.
 *
 * The fixture service imports local files, well-known types and a
 * `google.protobuf.MethodOptions` extension, so the import walk is exercised
 * beyond a single self-contained file.
 */

import assert from "node:assert";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import type { ProtocolRegistration, Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import { MetaSchema } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { fetchFileDescriptorSetBinary, fetchReflectionData } from "../../src/utils/reflection.ts";

const EXPECTED_SERVICES = ["fixture.v1.FixtureService", "grpc.health.v1.Health"];

// File names as protobuf-es reports them (no ".proto" suffix). Depth-first,
// imports before the importing file, starting from each listed
// service's file in listing order.
const EXPECTED_FILES = [
    "google/protobuf/empty",
    "google/protobuf/timestamp",
    "fixture/v1/common",
    "fixture/v1/legacy",
    "google/protobuf/descriptor",
    "fixture/v1/options",
    "fixture/v1/service",
    "grpc/health/v1/health",
];

const EXPECTED_SET_SHA256 = "f599ee06370a85fcb79361e63c2d352e6899dc53fa4c5b4ef699b5b2aec440a4";

const fixtureService = defineService(FixtureService, {
    get: () => create(MetaSchema, {}),
    ping: () => ({}),
});

/**
 * Wraps `Reflection()` so that only the v1alpha service reaches the router,
 * which is what a server that predates the v1 protocol looks like to a client.
 */
function reflectionV1alphaOnly(): ProtocolRegistration {
    const inner = Reflection();
    return {
        name: "reflection-v1alpha-only",
        setup(context) {
            inner.setup?.(context);
        },
        register(router: ConnectRouter) {
            const onlyV1alpha = new Proxy(router, {
                get(target, property, receiver) {
                    if (property === "service") {
                        return (...args: Parameters<ConnectRouter["service"]>) => {
                            const [service] = args;
                            return service.typeName === "grpc.reflection.v1alpha.ServerReflection" ? target.service(...args) : target;
                        };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            inner.register(onlyV1alpha);
        },
    };
}

interface FileAnswer {
    messageResponse: { case: "fileDescriptorResponse"; value: { fileDescriptorProto: Uint8Array[] } } | { case: string | undefined };
}
type ReflectionImpl = { serverReflectionInfo(requests: AsyncIterable<unknown>, context: unknown): AsyncIterable<FileAnswer> };

/**
 * Wraps `Reflection()` so that every file answer carries only the requested
 * file, without its imports — what servers built on
 * `@lambdalisue/connectrpc-grpcreflect` (Connectum 1.2 and earlier) send. The
 * client must then fetch each import by name, a path a closure-sending server
 * never exercises.
 */
function reflectionWithoutImports(stats: { trimmed: number }): ProtocolRegistration {
    const inner = Reflection();
    return {
        name: "reflection-without-imports",
        setup(context) {
            inner.setup?.(context);
        },
        register(router: ConnectRouter) {
            const trimming = new Proxy(router, {
                get(target, property, receiver) {
                    if (property !== "service") {
                        return Reflect.get(target, property, receiver);
                    }
                    return (...args: Parameters<ConnectRouter["service"]>) => {
                        const [service, implementation, options] = args;
                        const original = implementation as unknown as ReflectionImpl;
                        const trimmed: ReflectionImpl = {
                            async *serverReflectionInfo(requests, context) {
                                for await (const response of original.serverReflectionInfo(requests, context)) {
                                    if (response.messageResponse.case === "fileDescriptorResponse" && "value" in response.messageResponse) {
                                        const files = response.messageResponse.value.fileDescriptorProto;
                                        stats.trimmed += files.length - 1;
                                        response.messageResponse.value.fileDescriptorProto = files.slice(0, 1);
                                    }
                                    yield response;
                                }
                            },
                        };
                        return target.service(service, trimmed as unknown as typeof implementation, options);
                    };
                },
            });
            inner.register(trimming);
        },
    };
}

async function startServer(protocols: ProtocolRegistration[]): Promise<{ server: Server; url: string }> {
    const server = createServer({ services: [fixtureService], port: 0, protocols, interceptors: [], allowHTTP1: false });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "server should have an assigned port");
    return { server, url: `http://localhost:${port}` };
}

describe("CLI reflection client output", () => {
    let v1: { server: Server; url: string };
    let v1alphaOnly: { server: Server; url: string };
    let withoutImports: { server: Server; url: string };
    const withoutImportsStats = { trimmed: 0 };

    before(async () => {
        v1 = await startServer([Healthcheck(), Reflection()]);
        v1alphaOnly = await startServer([Healthcheck(), reflectionV1alphaOnly()]);
        withoutImports = await startServer([Healthcheck(), reflectionWithoutImports(withoutImportsStats)]);
    });

    after(async () => {
        await v1?.server.stop();
        await v1alphaOnly?.server.stop();
        await withoutImports?.server.stop();
    });

    it("fetchReflectionData returns the pinned services and file order", async () => {
        const result = await fetchReflectionData(v1.url);
        assert.deepStrictEqual(result.fileNames, EXPECTED_FILES);
        assert.deepStrictEqual(
            [...result.registry.files].map((f) => f.name),
            EXPECTED_FILES,
        );
        assert.deepStrictEqual(result.services, EXPECTED_SERVICES);
    });

    it("fetchFileDescriptorSetBinary returns the pinned bytes", async () => {
        const binpb = await fetchFileDescriptorSetBinary(v1.url);
        assert.strictEqual(createHash("sha256").update(binpb).digest("hex"), EXPECTED_SET_SHA256);
    });

    it("falls back to v1alpha when the server does not serve v1", async () => {
        const result = await fetchReflectionData(v1alphaOnly.url);
        assert.deepStrictEqual(result.fileNames, EXPECTED_FILES);
        const binpb = await fetchFileDescriptorSetBinary(v1alphaOnly.url);
        assert.strictEqual(createHash("sha256").update(binpb).digest("hex"), EXPECTED_SET_SHA256);
        assert.deepStrictEqual(result.services, EXPECTED_SERVICES);
    });

    it("fetches imports by name from a server that answers with single files", async () => {
        const result = await fetchReflectionData(withoutImports.url);
        assert.deepStrictEqual(result.fileNames, EXPECTED_FILES);
        const binpb = await fetchFileDescriptorSetBinary(withoutImports.url);
        assert.strictEqual(createHash("sha256").update(binpb).digest("hex"), EXPECTED_SET_SHA256);
        assert.ok(withoutImportsStats.trimmed > 0, "the server must have dropped imports from its answers");
    });
});

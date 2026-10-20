/**
 * Integration tests for gRPC Server Reflection
 *
 * Starts a real server with @connectum/healthcheck and @connectum/reflection
 * and checks what a reflection client builds from the answers: the service
 * list, and a FileRegistry rebuilt from a single file_containing_symbol answer
 * (which must carry every import the file needs). Request-level protocol
 * details are covered by conformance.test.ts.
 *
 * Transport: createGrpcTransport (HTTP/2, required for bidirectional streaming).
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { ServerReflection, type ServerReflectionResponse } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";
import { MetaSchema } from "../fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../fixtures/fixture/v1/service_pb.ts";

async function ask(transport: Transport, messageRequest: { case: "listServices" | "fileContainingSymbol" | "fileByFilename"; value: string }): Promise<ServerReflectionResponse> {
    const client = createClient(ServerReflection, transport);
    async function* requests() {
        yield { messageRequest };
    }
    for await (const response of client.serverReflectionInfo(requests())) {
        return response;
    }
    throw new Error("the reflection stream ended without a response");
}

async function listServices(transport: Transport): Promise<string[]> {
    const response = await ask(transport, { case: "listServices", value: "" });
    assert.strictEqual(response.messageResponse.case, "listServicesResponse");
    return response.messageResponse.value.service.map((s) => s.name);
}

describe("Reflection Integration", () => {
    let server: Server;
    let serverUrl: string;

    before(async () => {
        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck(), Reflection()],
            interceptors: [],
            allowHTTP1: false,
        });

        await server.start();
        const port = server.address?.port;
        assert.ok(port, "Server should have an assigned port");
        serverUrl = `http://localhost:${port}`;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("lists the services of the protocols registered before reflection", async () => {
        assert.deepStrictEqual(await listServices(createGrpcTransport({ baseUrl: serverUrl })), ["grpc.health.v1.Health"]);
    });

    it("answers a symbol with everything a client needs to rebuild the service", async () => {
        const response = await ask(createGrpcTransport({ baseUrl: serverUrl }), { case: "fileContainingSymbol", value: "grpc.health.v1.Health" });
        assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse");
        const files = response.messageResponse.value.fileDescriptorProto.map((bytes) => fromBinary(FileDescriptorProtoSchema, bytes));
        assert.strictEqual(files[0]?.name, "grpc/health/v1/health.proto");

        const registry = createFileRegistry(create(FileDescriptorSetSchema, { file: files }));
        const health = registry.getService("grpc.health.v1.Health");
        assert.ok(health, "the rebuilt registry should resolve the service");
        assert.deepStrictEqual(health.methods.map((m) => m.name).sort(), ["Check", "List", "Watch"]);
    });

    // The in-process router must serve the descriptors built once for the
    // server, not ones rebuilt from the by-then larger registry (which by then
    // also holds reflection's own files) — otherwise in-process and HTTP
    // clients see different listings.
    it("lists the same services in-process as over HTTP", async () => {
        const overHttp = await listServices(createGrpcTransport({ baseUrl: serverUrl }));
        const inProcess = await listServices(createLocalTransport(server));

        assert.deepStrictEqual(inProcess, overHttp);
    });
});

describe("Reflection Integration: server with nothing mounted before reflection", () => {
    let server: Server;
    let serverUrl: string;

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Reflection()], interceptors: [], allowHTTP1: false });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "Server should have an assigned port");
        serverUrl = `http://localhost:${port}`;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    // Protocol: list_services returns the mounted services, which here is none;
    // the stream still answers, with an empty list rather than an error.
    it("answers list_services with an empty list", async () => {
        const response = await ask(createGrpcTransport({ baseUrl: serverUrl }), { case: "listServices", value: "" });

        assert.strictEqual(response.messageResponse.case, "listServicesResponse");
        assert.deepStrictEqual(response.messageResponse.value.service, []);
    });

    // Protocol: an unknown file is NOT_FOUND (5) naming the file, not a failed stream.
    it("answers an unknown file with NOT_FOUND naming it", async () => {
        const response = await ask(createGrpcTransport({ baseUrl: serverUrl }), { case: "fileByFilename", value: "nope.proto" });

        assert.strictEqual(response.messageResponse.case, "errorResponse");
        assert.strictEqual(response.messageResponse.value.errorCode, 5);
        assert.match(response.messageResponse.value.errorMessage, /nope\.proto/);
    });
});

// Every RPC registered on the server's router passes through the server-level
// request gate, reflection included: an operator who requires credentials must not
// find the whole schema readable without them.
describe("Reflection Integration: request gate", () => {
    let server: Server;
    let serverUrl: string;
    const gated: string[] = [];

    before(async () => {
        server = createServer({
            services: [],
            port: 0,
            protocols: [Reflection()],
            interceptors: [],
            allowHTTP1: false,
            requestGate: (ctx) => {
                gated.push(ctx.method.name);
                throw new ConnectError("credentials required", Code.Unauthenticated);
            },
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "Server should have an assigned port");
        serverUrl = `http://localhost:${port}`;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    for (const [name, transport] of [
        ["HTTP", () => createGrpcTransport({ baseUrl: serverUrl })],
        ["in-process", () => createLocalTransport(server)],
    ] as const) {
        it(`rejects a reflection stream with the gate's error over ${name}`, async () => {
            gated.length = 0;
            await assert.rejects(ask(transport(), { case: "listServices", value: "" }), (err: unknown) => {
                const connectErr = ConnectError.from(err);
                assert.strictEqual(connectErr.code, Code.Unauthenticated);
                assert.strictEqual(connectErr.rawMessage, "credentials required");
                return true;
            });
            assert.deepStrictEqual(gated, ["ServerReflectionInfo"], "the gate must have been asked about the reflection RPC");
        });
    }
});

// Two servers in one process, each with its own Reflection(): a client of the first
// must never see the services of the second, including through an in-process transport
// created after the second server has been set up.
describe("Reflection Integration: two servers in one process", () => {
    let first: Server;
    let second: Server;

    before(async () => {
        first = createServer({
            services: [defineService(FixtureService, { get: () => create(MetaSchema, {}), ping: () => ({}) })],
            port: 0,
            protocols: [Healthcheck(), Reflection()],
            interceptors: [],
            allowHTTP1: false,
        });
        second = createServer({ services: [], port: 0, protocols: [Healthcheck(), Reflection()], interceptors: [], allowHTTP1: false });
        await first.start();
        await second.start();
    });

    after(async () => {
        for (const server of [first, second]) {
            if (server?.isRunning) {
                await server.stop();
            }
        }
    });

    it("lists each server's own services over HTTP and in-process, whichever was set up last", async () => {
        const expectedFirst = ["fixture.v1.FixtureService", "grpc.health.v1.Health"];
        const expectedSecond = ["grpc.health.v1.Health"];

        assert.deepStrictEqual(await listServices(createGrpcTransport({ baseUrl: `http://localhost:${first.address?.port}` })), expectedFirst);
        assert.deepStrictEqual(await listServices(createGrpcTransport({ baseUrl: `http://localhost:${second.address?.port}` })), expectedSecond);
        assert.deepStrictEqual(await listServices(createLocalTransport(first)), expectedFirst);
        assert.deepStrictEqual(await listServices(createLocalTransport(second)), expectedSecond);
    });
});

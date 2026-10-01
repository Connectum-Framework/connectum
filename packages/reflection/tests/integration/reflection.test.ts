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
import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createLocalTransport, createServer } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { ServerReflection, type ServerReflectionResponse } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";

async function ask(transport: Transport, messageRequest: { case: "listServices" | "fileContainingSymbol"; value: string }): Promise<ServerReflectionResponse> {
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

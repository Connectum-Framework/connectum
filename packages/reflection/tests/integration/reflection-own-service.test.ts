/**
 * Describing the reflection service through reflection.
 *
 * The listing leaves the reflection services out: they are infrastructure, not
 * part of the application's API. A client that is already talking to them can
 * still ask for their schema, as it can for any other mounted service, and
 * gets the same answer a descriptor of the upstream `reflection.proto` would
 * give, over both protocol versions and both transports.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, type Server } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { type ServerReflectionResponse, ServerReflection as V1 } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { ServerReflection as V1alpha } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";

type Query = { case: "listServices" | "fileContainingSymbol" | "fileByFilename"; value: string };

async function ask(transport: Transport, version: "v1" | "v1alpha", messageRequest: Query): Promise<ServerReflectionResponse> {
    async function* requests() {
        yield { messageRequest };
    }
    // v1alpha is wire-identical to v1; the response is read through the v1 type.
    const stream = version === "v1" ? createClient(V1, transport).serverReflectionInfo(requests()) : createClient(V1alpha, transport).serverReflectionInfo(requests() as never);
    for await (const response of stream as AsyncIterable<ServerReflectionResponse>) {
        return response;
    }
    throw new Error("the reflection stream ended without a response");
}

describe("describing the reflection service through reflection", () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Healthcheck(), Reflection()], interceptors: [], allowHTTP1: false });
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
            const service = `grpc.reflection.${version}.ServerReflection`;
            const file = `grpc/reflection/${version}/reflection.proto`;

            describe(`${version} over ${transportName}`, () => {
                it(`resolves ${service} to the file that declares it`, async () => {
                    const response = await ask(transport(), version, { case: "fileContainingSymbol", value: service });
                    assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse", JSON.stringify(response.messageResponse));
                    const files = response.messageResponse.value.fileDescriptorProto.map((bytes) => fromBinary(FileDescriptorProtoSchema, bytes));
                    assert.strictEqual(files[0]?.name, file);

                    // A client rebuilds the service from the answer alone.
                    const registry = createFileRegistry(create(FileDescriptorSetSchema, { file: files }));
                    const described = registry.getService(service);
                    assert.ok(described, "the rebuilt registry should resolve the reflection service");
                    assert.deepStrictEqual(
                        described.methods.map((method) => [method.name, method.methodKind]),
                        [["ServerReflectionInfo", "bidi_streaming"]],
                    );
                });

                it("resolves the method and the message types of the service", async () => {
                    for (const symbol of [`${service}.ServerReflectionInfo`, `grpc.reflection.${version}.ServerReflectionRequest`, `grpc.reflection.${version}.ServerReflectionResponse`, `grpc.reflection.${version}.ErrorResponse`]) {
                        const response = await ask(transport(), version, { case: "fileContainingSymbol", value: symbol });
                        assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse", `${symbol}: ${JSON.stringify(response.messageResponse)}`);
                        assert.strictEqual(fromBinary(FileDescriptorProtoSchema, response.messageResponse.value.fileDescriptorProto[0] ?? new Uint8Array()).name, file, symbol);
                    }
                });

                it("serves the file by name as well", async () => {
                    const response = await ask(transport(), version, { case: "fileByFilename", value: file });
                    assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse", JSON.stringify(response.messageResponse));
                });
            });
        }
    }

    it("still leaves the reflection services out of the listing", async () => {
        const response = await ask(createGrpcTransport({ baseUrl }), "v1", { case: "listServices", value: "" });
        assert.strictEqual(response.messageResponse.case, "listServicesResponse");
        assert.deepStrictEqual(
            response.messageResponse.value.service.map((s) => s.name),
            ["grpc.health.v1.Health"],
        );
    });
});

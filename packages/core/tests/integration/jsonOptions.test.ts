/**
 * jsonOptions integration tests
 *
 * Verifies that `CreateServerOptions.jsonOptions` is threaded through to the
 * underlying connectNodeAdapter and actually changes the JSON serialization of
 * responses. The oracle is the real HTTP response body, not the implementation:
 * a field with implicit presence (proto3 `int32 = 0`) must be present in the
 * JSON body when `alwaysEmitImplicit: true` and omitted when it is not set.
 *
 * The proto schema is built at runtime (no buf codegen in @connectum/core), so
 * the test stays self-contained and depends only on @bufbuild/protobuf.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { DescService, JsonReadOptions, JsonValue, JsonWriteOptions } from "@bufbuild/protobuf";
import { create, createFileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter, ServiceImpl } from "@connectrpc/connect";
import { createServer } from "../../src/Server.ts";
import type { Server, ServiceRoute } from "../../src/types.ts";

// =============================================================================
// RUNTIME PROTO SCHEMA
// =============================================================================

const PACKAGE = "connectum.test.v1";
const SERVICE_TYPE = `${PACKAGE}.EchoService`;

/**
 * Build a minimal proto3 schema at runtime:
 *
 *   package connectum.test.v1;
 *   message EchoRequest {}
 *   message EchoResponse { int32 value = 1; } // implicit presence
 *   service EchoService { rpc Echo(EchoRequest) returns (EchoResponse); }
 */
function buildEchoService(): DescService {
    const fileDescriptor = create(FileDescriptorProtoSchema, {
        name: "connectum/test/v1/echo.proto",
        package: PACKAGE,
        syntax: "proto3",
        messageType: [
            { name: "EchoRequest" },
            {
                name: "EchoResponse",
                field: [
                    {
                        name: "value",
                        jsonName: "value",
                        number: 1,
                        // LABEL_OPTIONAL = 1 (singular field with implicit presence in proto3)
                        label: 1,
                        // TYPE_INT32 = 5
                        type: 5,
                    },
                ],
            },
        ],
        service: [
            {
                name: "EchoService",
                method: [
                    {
                        name: "Echo",
                        inputType: `.${PACKAGE}.EchoRequest`,
                        outputType: `.${PACKAGE}.EchoResponse`,
                    },
                ],
            },
        ],
    });

    const registry = createFileRegistry(fileDescriptor, () => undefined);
    const service = registry.getService(SERVICE_TYPE);
    assert.ok(service, `service ${SERVICE_TYPE} should be resolvable from the runtime registry`);
    return service;
}

/**
 * ServiceRoute that always responds with `value` left at its zero default.
 *
 * @param perServiceJsonOptions - When provided, passed as the third argument of
 *   `router.service()` (the per-service lever), independent of the server-level option.
 */
function createEchoRoute(service: DescService, perServiceJsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>): ServiceRoute {
    return (router: ConnectRouter) => {
        const method = service.methods[0];
        assert.ok(method, "EchoService should expose its Echo method");
        // Respond with the message left at defaults (value = 0).
        // The schema is dynamic, so the typed ServiceImpl shape cannot be inferred here.
        const impl = { [method.localName]: () => create(method.output, {}) } as unknown as Partial<ServiceImpl<DescService>>;
        if (perServiceJsonOptions) {
            router.service(service, impl, { jsonOptions: perServiceJsonOptions });
        } else {
            router.service(service, impl);
        }
    };
}

// =============================================================================
// HTTP HELPER
// =============================================================================

/** Send a Connect unary JSON request and return the parsed response body. */
async function callEcho(port: number): Promise<JsonValue> {
    const response = await fetch(`http://127.0.0.1:${port}/${SERVICE_TYPE}/Echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
    assert.strictEqual(response.status, 200, `expected HTTP 200, got ${response.status}`);
    return (await response.json()) as JsonValue;
}

// =============================================================================
// TESTS
// =============================================================================

describe("CreateServerOptions.jsonOptions", () => {
    const service = buildEchoService();
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await server.stop();
            server = null;
        }
    });

    it("omits implicit-presence fields by default", async () => {
        server = createServer({
            services: [createEchoRoute(service)],
            port: 0,
        });
        await server.start();

        const port = server.address?.port;
        assert.ok(port, "server should expose a bound port");

        const body = await callEcho(port);
        assert.deepStrictEqual(body, {}, "zero-valued int32 must be omitted from the JSON body by default");
    });

    it("emits implicit-presence fields when alwaysEmitImplicit is enabled", async () => {
        server = createServer({
            services: [createEchoRoute(service)],
            port: 0,
            jsonOptions: { alwaysEmitImplicit: true },
        });
        await server.start();

        const port = server.address?.port;
        assert.ok(port, "server should expose a bound port");

        const body = await callEcho(port);
        assert.deepStrictEqual(body, { value: 0 }, "zero-valued int32 must be present when alwaysEmitImplicit is true");
    });

    it("supports the per-service lever (router.service options) without the server-level option", async () => {
        server = createServer({
            // No server-level jsonOptions -- the option is set per service instead.
            services: [createEchoRoute(service, { alwaysEmitImplicit: true })],
            port: 0,
        });
        await server.start();

        const port = server.address?.port;
        assert.ok(port, "server should expose a bound port");

        const body = await callEcho(port);
        assert.deepStrictEqual(body, { value: 0 }, "per-service jsonOptions must emit the zero-valued int32");
    });
});

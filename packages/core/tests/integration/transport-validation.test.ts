/**
 * Server.start() transport-validation integration tests
 *
 * A USER-registered bidi-streaming method on the default plaintext HTTP/1.1
 * server must fail startup (TransportValidationError, stable code); the same
 * registry on an h2c server must start cleanly. Protocol-contributed bidi
 * descriptors (the gRPC Reflection case — ServerReflectionInfo is bidi) must
 * NOT fail the user's startup: their transport limitations are documented.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescFile } from "@bufbuild/protobuf";
import { createServer } from "../../src/Server.ts";
import { TRANSPORT_VALIDATION_ERROR_CODE, TransportValidationError } from "../../src/TransportValidation.ts";
import type { ProtocolRegistration, ServiceRoute } from "../../src/types.ts";

const BIDI_FILE = {
    services: [
        {
            typeName: "acme.v1.ScannerService",
            methods: [{ name: "StreamCodes", methodKind: "bidi_streaming" }],
        },
    ],
} as unknown as DescFile;

/**
 * User service route contributing a bidi descriptor. buildRoutes intercepts
 * router.service() and records service.file BEFORE delegating to the real
 * Connect router — which rejects the structural mock, so the route swallows
 * that error: the registry entry is what the test needs.
 */
function bidiUserService(): ServiceRoute {
    return (router) => {
        try {
            router.service({ file: BIDI_FILE } as never, {} as never);
        } catch {
            // Connect router rejects the structural mock — irrelevant here:
            // the descriptor has already been recorded in the registry.
        }
    };
}

/** Protocol contributing the same bidi descriptor (the Reflection scenario). */
function bidiDescriptorProtocol(): ProtocolRegistration {
    return {
        name: "bidi-fixture",
        register(_router, context): void {
            (context.registry as DescFile[]).push(BIDI_FILE);
        },
    };
}

describe("Server.start() transport validation", () => {
    it("rejects startup for a user bidi service on default plaintext HTTP/1.1", async () => {
        const server = createServer({
            services: [bidiUserService()],
            port: 0,
            interceptors: [],
            // defaults: no TLS, allowHTTP1: true → plaintext HTTP/1.1
        });

        // The rejected promise and the 'error' event must carry the SAME object
        let emitted: unknown;
        server.on("error", (err) => {
            emitted = err;
        });

        await assert.rejects(
            () => server.start(),
            (err: unknown) => {
                assert.ok(err instanceof TransportValidationError, `expected TransportValidationError, got ${err}`);
                assert.strictEqual(err.code, TRANSPORT_VALIDATION_ERROR_CODE);
                assert.ok(err.message.includes("acme.v1.ScannerService.StreamCodes"));
                assert.strictEqual(emitted, err, "error event must deliver the identical error instance");
                return true;
            },
        );
    });

    it("starts cleanly for the same user service on h2c (allowHTTP1: false)", async () => {
        const server = createServer({
            services: [bidiUserService()],
            port: 0,
            interceptors: [],
            allowHTTP1: false,
        });

        await server.start();
        assert.ok(server.isRunning);
        await server.stop();
    });

    it("starts on plaintext HTTP/1.1 with transportValidation: warn", async () => {
        const server = createServer({
            services: [bidiUserService()],
            port: 0,
            interceptors: [],
            transportValidation: "warn",
        });

        await server.start();
        assert.ok(server.isRunning);
        await server.stop();
    });

    it("protocol-contributed bidi (Reflection scenario) does NOT fail startup on plaintext HTTP/1.1", async () => {
        const server = createServer({
            services: [],
            port: 0,
            protocols: [bidiDescriptorProtocol()],
            interceptors: [],
            // defaults: plaintext HTTP/1.1 — protocol bidi must not trip validation
        });

        await server.start();
        assert.ok(server.isRunning);
        await server.stop();
    });
});

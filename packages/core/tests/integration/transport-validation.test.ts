/**
 * Server.start() transport-validation integration tests
 *
 * A USER-mounted bidi-streaming method on the default plaintext HTTP/1.1
 * server must fail startup (TransportValidationError, stable code); the same
 * service on an h2c server must start cleanly. Protocol-contributed bidi
 * services (the gRPC Reflection case — ServerReflectionInfo is bidi) must
 * NOT fail the user's startup: their transport limitations are documented.
 * Neither must a bidi service that is only declared next to a mounted one.
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MountedService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import { defineService, type ServiceDefinition } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { TRANSPORT_VALIDATION_ERROR_CODE, TransportValidationError } from "../../src/TransportValidation.ts";
import type { ProtocolRegistration } from "../../src/types.ts";
import { ServerState } from "../../src/types.ts";
import { StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

/** User service with a bidi method (`streaming.v1.StreamingService.Bidi`). */
function bidiUserService(): ServiceDefinition {
    return {
        descriptor: StreamingService,
        register(router) {
            router.service(StreamingService, {});
        },
    };
}

/** Protocol mounting the same bidi service (the Reflection scenario). */
function bidiDescriptorProtocol(): ProtocolRegistration {
    return {
        name: "bidi-fixture",
        register(router): void {
            router.service(StreamingService, {});
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
                assert.ok(err.message.includes("streaming.v1.StreamingService.Bidi"));
                assert.strictEqual(emitted, err, "error event must deliver the identical error instance");
                return true;
            },
        );
        // A refused start leaves a stopped server that never bound a port.
        assert.strictEqual(server.state, ServerState.STOPPED);
        assert.strictEqual(server.address, null);
    });

    describe("TLS", () => {
        let tlsDir: string;
        let tls: { keyPath: string; certPath: string };

        before(() => {
            // A throwaway self-signed pair per run: no key material is committed.
            tlsDir = mkdtempSync(join(tmpdir(), "connectum-transport-validation-"));
            tls = { keyPath: join(tlsDir, "server.key"), certPath: join(tlsDir, "server.crt") };
            execFileSync(
                "openssl",
                ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", tls.keyPath, "-out", tls.certPath],
                { stdio: "ignore" },
            );
        });

        after(() => {
            rmSync(tlsDir, { recursive: true, force: true });
        });

        /** Start a TLS server with a user bidi service, returning the transport-validation diagnostics logged while starting. */
        async function startTls(allowHTTP1: boolean): Promise<string[]> {
            const original = console.warn;
            const warnings: string[] = [];
            console.warn = (...args: unknown[]): void => {
                warnings.push(args.map(String).join(" "));
            };
            const server = createServer({ services: [bidiUserService()], port: 0, host: "127.0.0.1", interceptors: [], tls, allowHTTP1 });
            try {
                await server.start();
                assert.ok(server.isRunning, "a TLS server with a bidi service must start whatever the diagnostics say");
            } finally {
                console.warn = original;
                await server.stop();
            }
            return warnings.filter((w) => w.includes(TRANSPORT_VALIDATION_ERROR_CODE));
        }

        // Transport guide: with TLS that still allows HTTP/1.1 a client may negotiate it over ALPN,
        // so a bidi method is a residual risk: one warning, never a refusal.
        it("starts a TLS server that allows HTTP/1.1, logging one warning that names the bidi method and the fix", async () => {
            const diagnostics = await startTls(true);

            assert.strictEqual(diagnostics.length, 1);
            assert.ok(diagnostics[0]?.includes("streaming.v1.StreamingService.Bidi"));
            assert.ok(diagnostics[0]?.includes("allowHTTP1: false"));
        });

        it("starts a TLS server that refuses HTTP/1.1 without any diagnostic", async () => {
            assert.deepStrictEqual(await startTls(false), []);
        });
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

    it("starts on plaintext HTTP/1.1 with transportValidation: warn, logging one warning that names the bidi method", async () => {
        // The warning has no channel other than the console, so it is read
        // from console.warn (replaced by hand: mock.method is absent under Bun).
        const original = console.warn;
        const warnings: string[] = [];
        console.warn = (...args: unknown[]): void => {
            warnings.push(args.map(String).join(" "));
        };
        const server = createServer({
            services: [bidiUserService()],
            port: 0,
            interceptors: [],
            transportValidation: "warn",
        });

        try {
            await server.start();
        } finally {
            console.warn = original;
        }
        try {
            assert.ok(server.isRunning);
            // "log once, start anyway": exactly one diagnostic, the same one the "error" mode would have thrown
            const diagnostics = warnings.filter((w) => w.includes(TRANSPORT_VALIDATION_ERROR_CODE));
            assert.strictEqual(diagnostics.length, 1);
            assert.ok(diagnostics[0]?.includes("streaming.v1.StreamingService.Bidi"));
        } finally {
            await server.stop();
        }
    });

    it("starts on plaintext HTTP/1.1 with transportValidation: off, logging nothing", async () => {
        const original = console.warn;
        const warnings: string[] = [];
        console.warn = (...args: unknown[]): void => {
            warnings.push(args.map(String).join(" "));
        };
        const server = createServer({
            services: [bidiUserService()],
            port: 0,
            interceptors: [],
            transportValidation: "off",
        });

        try {
            await server.start();
        } finally {
            console.warn = original;
        }
        try {
            assert.ok(server.isRunning);
            assert.deepStrictEqual(
                warnings.filter((w) => w.includes(TRANSPORT_VALIDATION_ERROR_CODE)),
                [],
            );
        } finally {
            await server.stop();
        }
    });

    // The check is about methods the server serves. A mounted unary service
    // whose .proto file also declares an unmounted bidi service must not be
    // rejected for a method nobody can call.
    it("ignores a bidi method of an unmounted service declared in a mounted file", async () => {
        const server = createServer({
            services: [defineService(MountedService, { ping: () => ({}) })],
            port: 0,
            interceptors: [],
            // defaults: plaintext HTTP/1.1 — a mounted bidi method would fail here
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

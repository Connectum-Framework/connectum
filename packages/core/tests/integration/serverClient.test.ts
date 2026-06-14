/**
 * Server.hasService / Server.client — automatic local/remote routing.
 *
 * Covers the "Automatic Local/Remote Routing Via Service Registry"
 * requirement (Phase 1a).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { createServer } from "../../src/Server.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

function makeEchoRoutes() {
    return (router: ConnectRouter) => {
        router.service(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
    };
}

/**
 * A second "remote" router-transport serving the same EchoService — used as a
 * fallback transport for the unregistered-service scenarios. We tag responses
 * with a marker so the test can prove the call went through the fallback path
 * (not the local one).
 */
function makeRemoteFallbackTransport(marker: string) {
    return createRouterTransport((router) => {
        router.service(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `${marker}:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
    });
}

describe("Server.hasService (registry lookup)", () => {
    it("returns true for a registered service", () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        assert.strictEqual(server.hasService(EchoService), true);
    });

    it("returns false for an unregistered service", () => {
        // Empty server — nothing registered.
        const server = createServer({ services: [] });
        assert.strictEqual(server.hasService(EchoService), false);
    });

    it("registry reflects services added before materialization", () => {
        const server = createServer({ services: [] });
        assert.strictEqual(server.hasService(EchoService), false, "not present yet");

        // hasService() above triggered materialization in older designs; in
        // this design the registry is rebuilt on first access only — confirm
        // that after a fresh server we can still observe addService updates
        // BEFORE the first registry probe.
        const fresh = createServer({ services: [] });
        fresh.addService(makeEchoRoutes());
        assert.strictEqual(fresh.hasService(EchoService), true);
    });
});

describe("Server.client (unified auto-routing)", () => {
    it("routes registered service to local invoke (no fallback needed)", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        const client = server.client(EchoService);
        const response = await client.echo(create(EchoRequestSchema, { message: "hi" }));
        // Local handler prefixes with "echo:"; fallback marker would differ.
        assert.strictEqual(response.message, "echo:hi");
        assert.strictEqual(server.address, null, "no TCP port opened");
    });

    it("uses local transport even when fallback is provided (local takes precedence)", async () => {
        // Registry HAS EchoService → local invoke must win regardless of the
        // fallback transport that the caller passed. Proven by the response
        // prefix: local handler prefixes with "echo:", the remote fallback
        // would prefix with "remote:".
        const server = createServer({ services: [makeEchoRoutes()] });
        const fallback = makeRemoteFallbackTransport("remote");
        const client = server.client(EchoService, { fallback });
        const response = await client.echo(create(EchoRequestSchema, { message: "test" }));
        assert.strictEqual(response.message, "echo:test", "local handler must be used, not fallback");
        assert.strictEqual(server.address, null, "no TCP port opened — proves no HTTP roundtrip");
    });

    it("uses fallback transport when service is not in registry", async () => {
        const emptyServer = createServer({ services: [] });
        const fallback = makeRemoteFallbackTransport("remote");

        const client = emptyServer.client(EchoService, { fallback });
        const response = await client.echo(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(response.message, "remote:x", "must go through fallback transport");
    });

    it("throws ConnectError(unimplemented) at client() time when no fallback and not local", () => {
        const emptyServer = createServer({ services: [] });
        try {
            emptyServer.client(EchoService);
            assert.fail("expected ConnectError to be thrown");
        } catch (err) {
            assert.ok(err instanceof ConnectError, `expected ConnectError, got: ${err}`);
            assert.strictEqual(err.code, Code.Unimplemented);
            assert.ok(
                err.rawMessage.includes(EchoService.typeName),
                `error message must include typeName, got: ${err.rawMessage}`,
            );
        }
    });

    it("addService before materialize → client() routes to local", async () => {
        const server = createServer({ services: [] });
        server.addService(makeEchoRoutes());
        assert.strictEqual(server.hasService(EchoService), true);

        const client = server.client(EchoService);
        const response = await client.echo(create(EchoRequestSchema, { message: "late" }));
        assert.strictEqual(response.message, "echo:late");
    });

    it("repeated client() calls consistently route to the same transport", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        const c1 = server.client(EchoService);
        const c2 = server.client(EchoService);

        const r1 = await c1.echo(create(EchoRequestSchema, { message: "a" }));
        const r2 = await c2.echo(create(EchoRequestSchema, { message: "b" }));

        // Both via local path → "echo:" prefix preserved across calls.
        assert.strictEqual(r1.message, "echo:a");
        assert.strictEqual(r2.message, "echo:b");
    });

    it("repeated client() calls for an unregistered service consistently use fallback", async () => {
        const server = createServer({ services: [] });
        const fallback = makeRemoteFallbackTransport("R");

        const c1 = server.client(EchoService, { fallback });
        const c2 = server.client(EchoService, { fallback });

        const r1 = await c1.echo(create(EchoRequestSchema, { message: "1" }));
        const r2 = await c2.echo(create(EchoRequestSchema, { message: "2" }));

        assert.strictEqual(r1.message, "R:1");
        assert.strictEqual(r2.message, "R:2");
    });

    it("server.client(LocalService) is semantically equivalent to server.localClient(LocalService)", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        const viaClient = server.client(EchoService);
        const viaLocalClient = server.localClient(EchoService);

        const a = await viaClient.echo(create(EchoRequestSchema, { message: "p" }));
        const b = await viaLocalClient.echo(create(EchoRequestSchema, { message: "p" }));

        assert.strictEqual(a.message, b.message);
    });
});

describe("Server._getRegisteredServiceTypeNames (internal accessor)", () => {
    it("exposes the typeName set after materialization", () => {
        const server = createServer({ services: [makeEchoRoutes()] }) as unknown as {
            _getRegisteredServiceTypeNames(): ReadonlySet<string>;
        };
        const names = server._getRegisteredServiceTypeNames();
        assert.ok(names.has(EchoService.typeName));
    });
});

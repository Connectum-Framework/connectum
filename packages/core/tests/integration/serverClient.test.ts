/**
 * Server.hasService / Server.client — automatic local/remote routing.
 *
 * Covers the "Automatic Local/Remote Routing Via Service Registry"
 * requirement (Phase 1a).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineService } from "../../src/defineService.ts";
import { singleTransportResolver } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

function makeEchoRoutes() {
    return defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

/**
 * A second "remote" router-transport serving the same EchoService — supplied via
 * a `remoteResolver` for the unregistered-service scenarios. Responses are tagged
 * with a marker so the test can prove the call went through the remote path.
 */
function makeRemoteTransport(marker: string) {
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

    it("uses local transport even when a remoteResolver is configured (local takes precedence)", async () => {
        // Registry HAS EchoService → local invoke must win regardless of the
        // remoteResolver. Proven by the prefix: local handler prefixes "echo:",
        // the remote transport would prefix "remote:".
        const server = createServer({
            services: [makeEchoRoutes()],
            remoteResolver: singleTransportResolver(makeRemoteTransport("remote")),
        });
        const client = server.client(EchoService);
        const response = await client.echo(create(EchoRequestSchema, { message: "test" }));
        assert.strictEqual(response.message, "echo:test", "local handler must be used, not the resolver");
        assert.strictEqual(server.address, null, "no TCP port opened — proves no HTTP roundtrip");
    });

    it("routes to the resolver-supplied transport when service is not local", async () => {
        const server = createServer({
            services: [],
            remoteResolver: singleTransportResolver(makeRemoteTransport("remote")),
        });
        const client = server.client(EchoService);
        const response = await client.echo(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(response.message, "remote:x", "must go through the resolved transport");
    });

    it("throws CatalogConfigError at client() time when not local and no remoteResolver", () => {
        const emptyServer = createServer({ services: [] });
        assert.throws(
            () => emptyServer.client(EchoService),
            (err: unknown) => err instanceof CatalogConfigError && err.message.includes(EchoService.typeName),
        );
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

    it("repeated client() calls for a remote service consistently use the resolver (cached)", async () => {
        let resolverCalls = 0;
        const remote = makeRemoteTransport("R");
        const server = createServer({
            services: [],
            remoteResolver: ({ typeName }) => {
                resolverCalls += typeName === EchoService.typeName ? 1 : 0;
                return remote;
            },
        });

        const c1 = server.client(EchoService);
        const c2 = server.client(EchoService);
        const r1 = await c1.echo(create(EchoRequestSchema, { message: "1" }));
        const r2 = await c2.echo(create(EchoRequestSchema, { message: "2" }));

        assert.strictEqual(r1.message, "R:1");
        assert.strictEqual(r2.message, "R:2");
        assert.strictEqual(resolverCalls, 1, "resolver must be cached per (typeName, endpoint)");
    });

    it("throws ConnectError(unavailable) when the resolver returns null for a remote service", () => {
        const server = createServer({ services: [], remoteResolver: () => null });
        try {
            server.client(EchoService);
            assert.fail("expected ConnectError");
        } catch (err) {
            assert.ok(err instanceof ConnectError, `expected ConnectError, got: ${err}`);
            assert.strictEqual(err.code, Code.Unavailable);
        }
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

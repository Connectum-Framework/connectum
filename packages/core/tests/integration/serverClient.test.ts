/**
 * Server.hasService / Server.client — automatic local/remote routing.
 *
 * Covers automatic local/remote routing via the service registry.
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

    it("a missing remoteResolver is a configuration error, not an RPC error code", () => {
        // The developer fixes this in code before running; it must not travel as
        // a ConnectError (and never as Unimplemented, which means a dispatch miss).
        const emptyServer = createServer({ services: [] });
        let thrown: unknown;
        try {
            emptyServer.client(EchoService);
        } catch (err) {
            thrown = err;
        }
        assert.ok(thrown instanceof CatalogConfigError, `expected CatalogConfigError, got: ${String(thrown)}`);
        assert.ok(!(thrown instanceof ConnectError), "a configuration mistake must not be a ConnectError");
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

    // Every router the server builds calls each protocol's `register` once, and
    // each in-process transport builds its own router. A constant count after
    // the first local call therefore means all later clients share that one
    // transport; a client that built a new transport would add a router.
    function countingRegisterProtocol() {
        const state = { registers: 0, name: "counting", register: () => void state.registers++ };
        return state;
    }

    it("repeated client() calls share one local transport: later clients build no further router", async () => {
        const protocol = countingRegisterProtocol();
        const server = createServer({ services: [makeEchoRoutes()], protocols: [protocol] });

        await server.client(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        const routersAfterFirstCall = protocol.registers;
        await server.client(EchoService).echo(create(EchoRequestSchema, { message: "b" }));
        await server.client(EchoService).echo(create(EchoRequestSchema, { message: "c" }));

        // The exact number of routers behind the first call is not part of the contract
        // (only "once per router built"); what is: nothing more is built afterwards.
        assert.ok(routersAfterFirstCall >= 1, "the first local call must register the protocol on at least one router");
        assert.strictEqual(protocol.registers, routersAfterFirstCall);
    });

    // Remote resolvers guide, "Endpoint hints": `server.client(Desc, { endpoint })` forwards the hint
    // to the resolver as `ctx.endpoint`, distinct hints get distinct transports, and the hint is
    // ignored for locally mounted services.
    it("forwards the endpoint hint to the resolver and keeps one transport per hint", async () => {
        const asked: Array<string | undefined> = [];
        const remotes: Record<string, ReturnType<typeof makeRemoteTransport>> = { eu: makeRemoteTransport("EU"), us: makeRemoteTransport("US") };
        const server = createServer({
            services: [],
            remoteResolver: ({ endpoint }) => {
                asked.push(endpoint);
                return remotes[endpoint ?? ""] ?? null;
            },
        });

        const eu1 = await server.client(EchoService, { endpoint: "eu" }).echo(create(EchoRequestSchema, { message: "1" }));
        const us = await server.client(EchoService, { endpoint: "us" }).echo(create(EchoRequestSchema, { message: "2" }));
        const eu2 = await server.client(EchoService, { endpoint: "eu" }).echo(create(EchoRequestSchema, { message: "3" }));

        assert.deepStrictEqual([eu1.message, us.message, eu2.message], ["EU:1", "US:2", "EU:3"]);
        assert.deepStrictEqual(asked, ["eu", "us"], "one resolution per (typeName, endpoint)");
    });

    it("names the endpoint in the Unavailable error when the resolver has no route for it", () => {
        const server = createServer({ services: [], remoteResolver: () => null });

        assert.throws(
            () => server.client(EchoService, { endpoint: "eu-west" }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable && err.message.includes("eu-west") && err.message.includes(EchoService.typeName),
        );
    });

    it("ignores the endpoint hint for a locally mounted service", async () => {
        let resolverCalls = 0;
        const server = createServer({
            services: [makeEchoRoutes()],
            remoteResolver: () => {
                resolverCalls++;
                return makeRemoteTransport("remote");
            },
        });

        const response = await server.client(EchoService, { endpoint: "eu" }).echo(create(EchoRequestSchema, { message: "x" }));

        assert.strictEqual(response.message, "echo:x");
        assert.strictEqual(resolverCalls, 0);
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

    it("server.client(LocalService) answers like server.localClient(LocalService), for every method", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        const viaClient = server.client(EchoService);
        const viaLocalClient = server.localClient(EchoService);

        for (const method of ["echo", "secureEcho", "rateLimitedEcho"] as const) {
            const a = await viaClient[method](create(EchoRequestSchema, { message: "p" }));
            const b = await viaLocalClient[method](create(EchoRequestSchema, { message: "p" }));
            assert.deepStrictEqual(a.message, b.message, method);
        }
        // The handlers differ per method, so equality above is not an artefact of one shared reply.
        assert.strictEqual((await viaClient.echo(create(EchoRequestSchema, { message: "p" }))).message, "echo:p");
        assert.strictEqual((await viaClient.secureEcho(create(EchoRequestSchema, { message: "p" }))).message, "p");
    });

    it("server.client(LocalService) and server.localClient(LocalService) fail the same way: same code, message and metadata", async () => {
        const server = createServer({
            services: [
                defineService(EchoService, {
                    echo: () => {
                        throw new ConnectError("no such item", Code.NotFound, { "x-detail": "42" });
                    },
                    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                }),
            ],
        });
        const failures: ConnectError[] = [];
        for (const client of [server.client(EchoService), server.localClient(EchoService)]) {
            try {
                await client.echo(create(EchoRequestSchema, { message: "p" }));
                assert.fail("expected the call to fail");
            } catch (err) {
                failures.push(ConnectError.from(err));
            }
        }

        const [viaClient, viaLocalClient] = failures as [ConnectError, ConnectError];
        assert.strictEqual(viaClient.code, Code.NotFound);
        assert.strictEqual(viaClient.code, viaLocalClient.code);
        assert.strictEqual(viaClient.rawMessage, "no such item");
        assert.strictEqual(viaClient.rawMessage, viaLocalClient.rawMessage);
        assert.strictEqual(viaClient.metadata.get("x-detail"), "42");
        assert.strictEqual(viaLocalClient.metadata.get("x-detail"), "42");
    });
});

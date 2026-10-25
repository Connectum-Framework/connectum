/**
 * createServer catalog integration — enabledServices mounting and startup
 * validation.
 */

import assert from "node:assert";
import { after, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineService } from "../../src/defineService.ts";
import { enabledServicesFromEnv } from "../../src/enabledServices.ts";
import { singleTransportResolver } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echo = () =>
    defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });

const streaming = () =>
    defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server() {},
        client: async () => create(CountSchema, { total: 0 }),
        async *bidi() {},
    });

describe("createServer enabledServices", () => {
    it("mounts every service when enabledServices is undefined", () => {
        const server = createServer({ services: [echo()] });
        assert.equal(server.hasService(EchoService), true);
    });

    it("does not mount a service excluded from enabledServices", () => {
        const server = createServer({ services: [echo()], enabledServices: [] });
        assert.equal(server.hasService(EchoService), false, "excluded service must not be local");
    });

    it("mounts only the services listed in enabledServices", () => {
        const server = createServer({ services: [echo(), streaming()], enabledServices: [EchoService.typeName] });
        assert.equal(server.hasService(EchoService), true);
        // A second configured service that is not listed stays unmounted.
        assert.equal(server.hasService(StreamingService), false, "a service outside the list must not be local");
    });

    // The one-line configuration `enabledServices: enabledServicesFromEnv(process.env.X)`:
    // an unset variable keeps the server's default (everything mounted), named services mount
    // only themselves, and `[]` stays the way to mount none of the supplied services.
    describe("enabledServices: enabledServicesFromEnv(value)", () => {
        it("mounts every supplied service for an unset or empty variable", () => {
            for (const value of [undefined, "", "  "]) {
                const server = createServer({ services: [echo(), streaming()], enabledServices: enabledServicesFromEnv(value) });
                assert.equal(server.hasService(EchoService), true, `value ${JSON.stringify(value)}`);
                assert.equal(server.hasService(StreamingService), true, `value ${JSON.stringify(value)}`);
            }
        });

        it("mounts only the services the variable names", () => {
            const server = createServer({ services: [echo(), streaming()], enabledServices: enabledServicesFromEnv(` ${EchoService.typeName} `) });
            assert.equal(server.hasService(EchoService), true);
            assert.equal(server.hasService(StreamingService), false);
        });

        it("mounts none of the supplied services only for an explicit empty list", () => {
            const server = createServer({ services: [echo()], enabledServices: [] });
            assert.equal(server.hasService(EchoService), false);
        });
    });

    // Service catalog guide: a service outside `enabledServices` is remote — it is not served
    // locally, and `server.client()` reaches it through the resolver instead.
    it("serves a listed service and reaches an unlisted one through the resolver", async () => {
        const remote = createRouterTransport((router) => {
            router.service(StreamingService, {
                echo: (req) => create(ItemSchema, { value: `remote:${req.value}`, sequence: req.sequence }),
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            });
        });
        const server = createServer({
            services: [echo(), streaming()],
            enabledServices: [EchoService.typeName],
            remoteResolver: singleTransportResolver(remote),
        });

        const local = await server.client(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        const viaResolver = await server.client(StreamingService).echo(create(ItemSchema, { value: "b", sequence: 0 }));

        assert.equal(local.message, "echo:a");
        assert.equal(viaResolver.value, "remote:b", "the unlisted service must not be answered by its local implementation");
    });

    it("answers a direct in-process call to an unlisted service with Unimplemented", async () => {
        const server = createServer({ services: [echo(), streaming()], enabledServices: [EchoService.typeName] });

        await assert.rejects(
            () => server.localClient(StreamingService).echo(create(ItemSchema, { value: "b", sequence: 0 })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unimplemented,
        );
    });
});

describe("createServer startup catalog validation", () => {
    it("rejects start() when enabledServices is not a subset of the catalog", async () => {
        const server = createServer({
            services: [],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            enabledServices: ["unknown.v1.GhostService"],
        });
        await assert.rejects(
            server.start(),
            (err: unknown) => err instanceof CatalogConfigError && err.message.includes("unknown.v1.GhostService"),
        );
        // A refused start leaves a stopped server that never bound a port.
        assert.equal(server.state, "stopped");
        assert.equal(server.address, null);
    });

    it("starts when enabledServices is a subset of the catalog", async () => {
        const server = createServer({
            services: [echo()],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            enabledServices: [EchoService.typeName],
            port: 0,
        });
        await server.start();
        assert.equal(server.state, "running");
        after(async () => {
            if (server.state === "running") await server.stop();
        });
    });
});

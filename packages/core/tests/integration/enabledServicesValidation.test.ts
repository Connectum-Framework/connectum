/**
 * `enabledServices` is checked against the services the server was given, with
 * or without a catalog.
 *
 * A misspelled type name (often read from an environment variable) used to
 * start a server that mounted none of its services: `start()` succeeded, the
 * state was `running`, and every call came back `unimplemented`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echo = () =>
    defineService(EchoService, {
        echo: (request) => create(EchoResponseSchema, { message: `local:${request.message}`, timestamp: 0n }),
        secureEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
        rateLimitedEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
    });

const streaming = () =>
    defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server() {},
        client: async () => create(CountSchema, { total: 0 }),
        async *bidi() {},
    });

const base = { port: 0, host: "127.0.0.1", allowHTTP1: false } as const;

describe("enabledServices against the supplied services", () => {
    it("rejects start() for a typo when no catalog is configured, naming the entry and the services available", async () => {
        const server = createServer({ ...base, services: [echo(), streaming()], enabledServices: [`${StreamingService.typeName}x`] });

        await assert.rejects(server.start(), (error: unknown) => {
            assert.ok(error instanceof CatalogConfigError);
            assert.ok(error.message.includes(`${StreamingService.typeName}x`), error.message);
            assert.ok(error.message.includes(EchoService.typeName) && error.message.includes(StreamingService.typeName), `must list what is available: ${error.message}`);
            assert.match(error.message, /enabledServices/);
            return true;
        });
        assert.equal(server.state, "stopped");
        assert.equal(server.address, null, "no listener may be left behind");
    });

    it("names only the unknown entries when a list mixes valid and misspelled ones", async () => {
        const server = createServer({ ...base, services: [echo()], enabledServices: [EchoService.typeName, "acme.v1.Ghost"] });

        await assert.rejects(server.start(), (error: unknown) => {
            assert.ok(error instanceof CatalogConfigError);
            assert.ok(error.message.includes("acme.v1.Ghost"));
            assert.ok(error.message.includes("1 typeName(s)"), error.message);
            return true;
        });
    });

    it("also rejects an entry that is in the catalog but matches none of the supplied services", async () => {
        const server = createServer({
            ...base,
            services: [echo()],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            enabledServices: [StreamingService.typeName],
        });

        await assert.rejects(server.start(), (error: unknown) => error instanceof CatalogConfigError && error.message.includes(StreamingService.typeName));
    });

    it("keeps reporting an entry that is absent from the catalog as such", async () => {
        const server = createServer({ ...base, services: [echo()], catalog: defineCatalog({ [EchoService.typeName]: EchoService }), enabledServices: ["acme.v1.Ghost"] });

        await assert.rejects(server.start(), (error: unknown) => error instanceof CatalogConfigError && error.message.includes("absent from the catalog"));
    });

    it("starts with a valid list, mounting exactly the listed services", async () => {
        const server = createServer({ ...base, services: [echo(), streaming()], enabledServices: [EchoService.typeName] });
        try {
            await server.start();
            assert.equal(server.hasService(EchoService), true);
            assert.equal(server.hasService(StreamingService), false);
            const response = await server.localClient(EchoService).echo({ message: "x" });
            assert.equal(response.message, "local:x");
            const unmounted = await server.localClient(StreamingService).echo({ value: "x", sequence: 0 }).catch((e: unknown) => e);
            assert.ok(unmounted instanceof ConnectError && unmounted.code === Code.Unimplemented);
        } finally {
            if (server.state === "running") await server.stop();
        }
    });

    it("starts with an empty list, which mounts nothing on purpose", async () => {
        const server = createServer({ ...base, services: [echo()], enabledServices: [] });
        try {
            await server.start();
            assert.equal(server.hasService(EchoService), false);
        } finally {
            if (server.state === "running") await server.stop();
        }
    });

    it("counts a service added with addService() before start()", async () => {
        const server = createServer({ ...base, services: [echo()], enabledServices: [StreamingService.typeName] });
        server.addService(streaming());
        try {
            await server.start();
            assert.equal(server.hasService(StreamingService), true);
        } finally {
            if (server.state === "running") await server.stop();
        }
    });
});

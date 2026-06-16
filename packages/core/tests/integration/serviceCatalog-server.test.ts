/**
 * createServer catalog integration — enabledServices mounting + startup
 * validation (sections 6-7 of the service-catalog change).
 */

import assert from "node:assert";
import { after, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

const echo = () =>
    defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
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
        const server = createServer({ services: [echo()], enabledServices: [EchoService.typeName] });
        assert.equal(server.hasService(EchoService), true);
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

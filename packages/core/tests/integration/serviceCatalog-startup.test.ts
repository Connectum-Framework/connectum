/**
 * Startup behavior for automatic local routing and unused catalog entries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createEventBus } from "../../../events/src/EventBus.ts";
import { MemoryAdapter } from "../../../events/src/MemoryAdapter.ts";
import { UnmountedService } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echo = () =>
    defineService(EchoService, {
        echo: (request) => create(EchoResponseSchema, { message: `local:${request.message}`, timestamp: 0n }),
        secureEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
        rateLimitedEcho: (request) => create(EchoResponseSchema, { message: request.message, timestamp: 0n }),
    });

const catalog = defineCatalog({
    [EchoService.typeName]: EchoService,
    [StreamingService.typeName]: StreamingService,
    [UnmountedService.typeName]: UnmountedService,
});

describe("service catalog startup", () => {
    it("detects mounted RPCs locally and does not resolve unused catalog or event services", async () => {
        let resolverCalls = 0;
        const eventBus = createEventBus({
            adapter: MemoryAdapter(),
            routes: [(router) => router.service(UnmountedService, { noop: async () => {} })],
        });
        const server = createServer({
            services: [echo()],
            catalog,
            eventBus,
            port: 0,
            remoteResolver: () => {
                resolverCalls += 1;
                return null;
            },
        });

        try {
            await server.start();

            assert.equal(server.hasService(EchoService), true);
            assert.equal(server.hasService(StreamingService), false);
            assert.equal(server.hasService(UnmountedService), false);
            assert.equal(resolverCalls, 0);

            const response = await server.client(EchoService).echo({ message: "hello" });
            assert.equal(response.message, "local:hello");
            assert.equal(resolverCalls, 0);
        } finally {
            if (server.state === "running") await server.stop();
        }
    });

    it("starts with an unused remote catalog entry and no resolver", async () => {
        const server = createServer({ services: [echo()], catalog, port: 0 });

        try {
            await server.start();
            assert.equal(server.state, "running");
            assert.equal(server.hasService(StreamingService), false);
        } finally {
            if (server.state === "running") await server.stop();
        }
    });

    it("keeps the enabled-services catalog-key check at startup", async () => {
        const server = createServer({
            services: [echo()],
            catalog,
            enabledServices: ["missing.v1.Service", "also-missing.v1.Service"],
            port: 0,
        });

        await assert.rejects(
            server.start(),
            (error: unknown) => error instanceof CatalogConfigError && error.message.includes("missing.v1.Service") && error.message.includes("also-missing.v1.Service"),
        );
        assert.equal(server.state, "stopped");
    });

    it("resolves a missing remote route only when that remote client is requested", async () => {
        let resolverCalls = 0;
        const server = createServer({
            services: [],
            catalog,
            port: 0,
            remoteResolver: () => {
                resolverCalls += 1;
                return null;
            },
        });

        try {
            await server.start();
            assert.equal(resolverCalls, 0);

            assert.throws(
                () => server.client(StreamingService),
                (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable,
            );
            assert.equal(resolverCalls, 1);
        } finally {
            if (server.state === "running") await server.stop();
        }
    });
});

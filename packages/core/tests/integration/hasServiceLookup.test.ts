/**
 * `server.hasService()` is a lookup.
 *
 * It used to build every route on the first call, which runs the factories of
 * lazy services and freezes `addService()`, `addInterceptor()` and
 * `addProtocol()`. For the services the application defines, the answer is
 * known from the definitions and `enabledServices` alone.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { defineLazyService, defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { ProtocolRegistration } from "../../src/types.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echoHandlers = () => ({
    echo: () => create(EchoResponseSchema, { message: "e", timestamp: 0n }),
    secureEcho: () => create(EchoResponseSchema, { message: "s", timestamp: 0n }),
    rateLimitedEcho: () => create(EchoResponseSchema, { message: "r", timestamp: 0n }),
});

const streamingHandlers = () => ({
    echo: (req: { value: string; sequence: number }) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
    async *server() {},
    client: async () => create(CountSchema, { total: 0 }),
    async *bidi() {},
});

const noopInterceptor = () => (next: (req: never) => Promise<never>) => next;

describe("server.hasService", () => {
    it("answers true for a lazy service without running its factory or freezing the configuration", () => {
        let factoryRuns = 0;
        const server = createServer({
            services: [
                defineLazyService(EchoService, () => {
                    factoryRuns++;
                    return echoHandlers();
                }),
            ],
        });

        assert.strictEqual(server.hasService(EchoService), true);
        assert.strictEqual(factoryRuns, 0, "a lookup must not run user factories");

        server.addService(defineService(StreamingService, streamingHandlers()));
        server.addInterceptor(noopInterceptor() as never);
        server.addProtocol({ name: "late", register() {} });
        assert.strictEqual(server.hasService(StreamingService), true, "a service added after an earlier lookup is seen by the next one");
    });

    it("runs the factory once, when the routes are built, as before", async () => {
        let factoryRuns = 0;
        const server = createServer({
            port: 0,
            host: "127.0.0.1",
            allowHTTP1: false,
            services: [
                defineLazyService(EchoService, () => {
                    factoryRuns++;
                    return echoHandlers();
                }),
            ],
        });
        server.hasService(EchoService);
        await server.start();
        try {
            assert.strictEqual(factoryRuns, 1);
            assert.strictEqual(server.hasService(EchoService), true);
        } finally {
            await server.stop();
        }
    });

    it("answers false for a service that enabledServices leaves out, without building routes", () => {
        let factoryRuns = 0;
        const server = createServer({
            enabledServices: [StreamingService.typeName],
            services: [
                defineLazyService(EchoService, () => {
                    factoryRuns++;
                    return echoHandlers();
                }),
                defineService(StreamingService, streamingHandlers()),
            ],
        });
        assert.strictEqual(server.hasService(EchoService), false);
        assert.strictEqual(server.hasService(StreamingService), true);
        assert.strictEqual(factoryRuns, 0);
        server.addInterceptor(noopInterceptor() as never);
    });

    it("answers false for a service nobody defined, when no protocol could provide it", () => {
        const server = createServer({ services: [defineService(EchoService, echoHandlers())] });
        assert.strictEqual(server.hasService(StreamingService), false);
        server.addService(defineService(StreamingService, streamingHandlers()));
    });

    it("finds a service provided by a protocol, which needs the routes built", () => {
        const provider: ProtocolRegistration = {
            name: "provider",
            register(router: ConnectRouter) {
                router.service(StreamingService, streamingHandlers());
            },
        };
        const server = createServer({ services: [defineService(EchoService, echoHandlers())], protocols: [provider] });
        assert.strictEqual(server.hasService(EchoService), true);
        assert.strictEqual(server.hasService(StreamingService), true);
    });

    it("gives the same answer before and after the routes are built", () => {
        const make = () =>
            createServer({
                enabledServices: [EchoService.typeName],
                services: [defineService(EchoService, echoHandlers()), defineService(StreamingService, streamingHandlers())],
            });
        const lookedUpFirst = make();
        const builtFirst = make();
        builtFirst.localClient(EchoService); // materializes the routes
        for (const desc of [EchoService, StreamingService]) {
            assert.strictEqual(lookedUpFirst.hasService(desc), builtFirst.hasService(desc), desc.typeName);
        }
    });
});

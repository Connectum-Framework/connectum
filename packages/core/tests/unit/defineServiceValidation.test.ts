/**
 * Mistakes in the handlers given to `defineService` / `defineLazyService`, and
 * the same service defined twice.
 *
 * They used to surface late or without a name: a lazy factory returning
 * `undefined` failed `start()` with "Cannot convert undefined or null to
 * object", an `async` factory mounted a service whose every method was
 * `unimplemented`, and a duplicate silently kept the last handler set.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineLazyService, defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echoHandlers = (tag = "e") => ({
    echo: () => create(EchoResponseSchema, { message: tag, timestamp: 0n }),
    secureEcho: () => create(EchoResponseSchema, { message: tag, timestamp: 0n }),
    rateLimitedEcho: () => create(EchoResponseSchema, { message: tag, timestamp: 0n }),
});

const base = { port: 0, host: "127.0.0.1", allowHTTP1: false } as const;

describe("defineService handlers", () => {
    for (const [label, value] of [
        ["undefined", undefined],
        ["null", null],
        ["a string", "handlers"],
        ["a Promise", Promise.resolve(echoHandlers())],
    ] as const) {
        it(`rejects ${label}, naming the service`, () => {
            assert.throws(
                () => defineService(EchoService, value as never),
                (error: unknown) => {
                    assert.ok(error instanceof TypeError);
                    assert.ok(error.message.includes(EchoService.typeName), error.message);
                    assert.match(error.message, /defineService/);
                    return true;
                },
            );
        });
    }

    it("rejects a handler that is not a function, naming the service and the method", () => {
        assert.throws(
            () => defineService(EchoService, { ...echoHandlers(), echo: "nope" } as never),
            (error: unknown) => error instanceof TypeError && error.message.includes(EchoService.typeName) && error.message.includes("echo"),
        );
    });

    it("accepts a complete handler set and a partial one (an unimplemented method stays unimplemented)", () => {
        defineService(EchoService, echoHandlers());
        defineService(EchoService, { echo: echoHandlers().echo } as never);
    });
});

describe("defineLazyService factory result", () => {
    const lazy = (factory: () => unknown) => defineLazyService(EchoService, factory as never);
    const mountVia = (factory: () => unknown) => createServer({ ...base, services: [lazy(factory)] }).start();

    it("does not run the factory when the service is defined", () => {
        let runs = 0;
        lazy(() => {
            runs++;
            return echoHandlers();
        });
        assert.strictEqual(runs, 0);
    });

    it("fails start() naming the service when the factory returns undefined", async () => {
        await assert.rejects(mountVia(() => undefined), (error: unknown) => error instanceof TypeError && error.message.includes(EchoService.typeName) && /defineLazyService/.test(error.message));
    });

    it("fails start() saying the factory must be synchronous when it returns a Promise", async () => {
        await assert.rejects(
            mountVia(async () => echoHandlers()),
            (error: unknown) => {
                assert.ok(error instanceof TypeError);
                assert.ok(error.message.includes(EchoService.typeName), error.message);
                assert.match(error.message, /synchronous/);
                return true;
            },
        );
    });

    it("fails start() for a member that is not a function", async () => {
        await assert.rejects(
            mountVia(() => ({ ...echoHandlers(), secureEcho: 42 })),
            (error: unknown) => error instanceof TypeError && error.message.includes("secureEcho"),
        );
    });

    it("mounts a valid factory result", async () => {
        const server = createServer({ ...base, services: [lazy(() => echoHandlers("lazy"))] });
        await server.start();
        try {
            assert.strictEqual((await server.localClient(EchoService).echo({ message: "x" })).message, "lazy");
        } finally {
            await server.stop();
        }
    });
});

describe("the same service defined twice", () => {
    it("is rejected by createServer(), naming the type name", () => {
        assert.throws(
            () => createServer({ ...base, services: [defineService(EchoService, echoHandlers("first")), defineService(EchoService, echoHandlers("second"))] }),
            (error: unknown) => error instanceof CatalogConfigError && error.message.includes(EchoService.typeName) && /more than once/.test(error.message),
        );
    });

    it("is rejected by addService() against a service given to createServer()", () => {
        const server = createServer({ ...base, services: [defineService(EchoService, echoHandlers())] });
        assert.throws(
            () => server.addService(defineService(EchoService, echoHandlers("other"))),
            (error: unknown) => error instanceof CatalogConfigError && error.message.includes(EchoService.typeName),
        );
        assert.strictEqual(server.routes.length, 1, "the rejected definition must not be added");
    });

    it("accepts different services and a service added once", () => {
        const server = createServer({ ...base, services: [defineService(EchoService, echoHandlers())] });
        server.addService(
            defineService(StreamingService, {
                echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            }),
        );
        assert.strictEqual(server.routes.length, 2);
    });
});

/**
 * The servers this package builds for tests must not print the "readMaxBytes is
 * not set" warning of `createServer()`: they have no untrusted caller, none of
 * their helpers takes a read limit that could silence it, and a suite would
 * otherwise repeat the line for every server it creates. They run with the
 * transport's own cap, which is the limit an unset option gets, so a message
 * above gRPC's usual 4 MiB must still go through.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createServer, defineCatalog, defineService } from "@connectum/core";
import { createMockContext } from "../../src/mockContext.ts";
import { createTestServer } from "../../src/test-server.ts";
import { defaultCompare, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

const warnings: string[] = [];
const originalWarn = console.warn;

before(() => {
    console.warn = (...args: unknown[]): void => {
        warnings.push(args.map(String).join(" "));
    };
});
after(() => {
    console.warn = originalWarn;
});

const echoRoutes = () =>
    defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message.length}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });

const readLimitWarnings = (): string[] => warnings.filter((line) => line.includes("readMaxBytes is not set"));

// Registered before the assertions below, so the harness servers exist by then.
transportParityTest("a parity scenario with no read limit accepts a 5 MiB message on both transports", {
    services: [echoRoutes()],
    scenario: async ({ transport }) => {
        const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x".repeat(5 * 1024 * 1024) }));
        return { response: { message: res.message } };
    },
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { message: `echo:${5 * 1024 * 1024}` });
        defaultCompare(http, local);
    },
});

describe("test servers and the unset read limit warning", () => {
    it("createTestServer writes no warning and accepts a 5 MiB message", async () => {
        const server = await createTestServer({ services: [echoRoutes()] });
        try {
            const res = await createClient(EchoService, server.transport).echo(create(EchoRequestSchema, { message: "x".repeat(5 * 1024 * 1024) }));
            assert.strictEqual(res.message, `echo:${5 * 1024 * 1024}`);
        } finally {
            await server.close();
        }
        assert.deepStrictEqual(readLimitWarnings(), []);
    });

    it("createMockContext writes no warning", () => {
        createMockContext({ catalog: defineCatalog({ [EchoService.typeName]: EchoService }), mocks: [] });
        assert.deepStrictEqual(readLimitWarnings(), []);
    });

    it("the parity harness servers wrote no warning", () => {
        assert.deepStrictEqual(readLimitWarnings(), []);
    });

    it("control: a bare createServer() in the same process does write it, so the checks above can fail", () => {
        createServer({ services: [echoRoutes()], port: 0 });
        assert.strictEqual(readLimitWarnings().length, 1);
    });
});

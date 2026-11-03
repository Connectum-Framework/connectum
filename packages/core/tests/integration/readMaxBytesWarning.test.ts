/**
 * `createServer()` without `readMaxBytes`: the default stays Connect's cap of
 * 4294967295 bytes, and the server says so once through its logger.
 *
 * The warning exists because an authentication interceptor runs only after a
 * request message has been received, so an unset limit lets one oversized
 * request from an unauthenticated caller exhaust memory. These cases pin when
 * it is written (exactly once, at creation, only when the option is unset),
 * where it goes (the `logger` option, `console` without one), that it is
 * silenced by setting the option, that nothing is written for a construction
 * that throws, and that the limit itself was NOT lowered.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { CreateServerOptions, ServerLogger } from "../../src/types.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

type Level = "info" | "warn" | "error";

function recorder(): { readonly logger: ServerLogger; readonly calls: Array<{ level: Level; message: string }> } {
    const calls: Array<{ level: Level; message: string }> = [];
    const record =
        (level: Level) =>
        (message: string): void => {
            calls.push({ level, message });
        };
    return { logger: { info: record("info"), warn: record("warn"), error: record("error") }, calls };
}

const echoService = () =>
    defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });

function make(options: Partial<CreateServerOptions>) {
    return createServer({ services: [echoService()], port: 0, host: "127.0.0.1", allowHTTP1: false, ...options });
}

describe("createServer() without readMaxBytes", () => {
    it("warns once through the logger, naming the option, the transport cap and the guide", () => {
        const log = recorder();
        make({ logger: log.logger });

        assert.strictEqual(log.calls.length, 1, "exactly one message, and no info or error");
        const [only] = log.calls;
        assert.strictEqual(only?.level, "warn");
        assert.match(only?.message ?? "", /^createServer: readMaxBytes is not set, so incoming messages are not limited/);
        assert.ok(only?.message.includes("4294967295"), "the transport cap is named");
        assert.ok(only?.message.includes("https://connectum.dev/en/guide/security/request-admission"), "the guide is named");
    });

    it("warns once per server, not once per start or stop", async () => {
        const log = recorder();
        const server = make({ logger: log.logger });
        await server.start();
        await server.stop();

        assert.strictEqual(log.calls.filter((call) => call.level === "warn" && call.message.includes("readMaxBytes")).length, 1);
    });

    it("warns for each server that is created without the option", () => {
        const log = recorder();
        make({ logger: log.logger });
        make({ logger: log.logger });
        assert.strictEqual(log.calls.length, 2);
    });

    for (const readMaxBytes of [1, 1024 * 1024, 4294967295]) {
        it(`does not warn when readMaxBytes is ${readMaxBytes} (4294967295 is the largest allowed value)`, () => {
            const log = recorder();
            make({ logger: log.logger, readMaxBytes });
            assert.deepStrictEqual(log.calls, []);
        });
    }

    it("does not warn, and still throws, for an invalid readMaxBytes", () => {
        const log = recorder();
        assert.throws(() => make({ logger: log.logger, readMaxBytes: 0 }), RangeError);
        assert.deepStrictEqual(log.calls, []);
    });

    it("does not warn when construction fails on another option", () => {
        const log = recorder();
        assert.throws(() => make({ logger: log.logger, port: -1 }), RangeError);
        assert.deepStrictEqual(log.calls, []);
    });

    it("can be silenced by a logger whose warn drops it", () => {
        const dropped: string[] = [];
        make({ logger: { info: () => {}, warn: (message) => void dropped.push(message), error: () => {} } });
        assert.strictEqual(dropped.length, 1, "the logger received it and is free to drop it");
    });

    it("does not let a throwing logger fail createServer()", () => {
        assert.doesNotThrow(() =>
            make({
                logger: {
                    info: () => {},
                    warn: () => {
                        throw new Error("logger is broken");
                    },
                    error: () => {},
                },
            }),
        );
    });

    describe("without a logger option", () => {
        let original: typeof console.warn;
        let written: unknown[][];

        beforeEach(() => {
            original = console.warn;
            written = [];
            console.warn = (...args: unknown[]) => {
                written.push(args);
            };
        });
        afterEach(() => {
            console.warn = original;
        });

        it("writes the warning to console.warn", () => {
            make({});
            assert.strictEqual(written.length, 1);
            assert.match(String(written[0]?.[0]), /readMaxBytes is not set/);
        });

        it("writes nothing when readMaxBytes is set", () => {
            make({ readMaxBytes: 1024 });
            assert.deepStrictEqual(written, []);
        });
    });

    it("leaves the limit unchanged: a request message above gRPC's 4 MiB convention is still accepted", async () => {
        const log = recorder();
        const server = make({ logger: log.logger });
        await server.start();
        try {
            const port = server.address?.port;
            assert.ok(port, "server must bind a port");
            const client = createClient(EchoService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` }));
            const message = "x".repeat(5 * 1024 * 1024);
            const res = await client.echo(create(EchoRequestSchema, { message }));
            assert.strictEqual(res.message.length, message.length);
        } finally {
            await server.stop();
        }
    });
});

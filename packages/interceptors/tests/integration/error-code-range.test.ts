/**
 * Numeric `code` of a thrown value, as clients see it over real transports.
 *
 * A handler can throw any value, including an object whose `code` is a number
 * that is not a Connect code (a system errno, an HTTP status, `0`, `NaN`).
 * Oracle: the Connect protocol and the gRPC status model define exactly the codes
 * 1..16 for a failure; anything else is not a status a client can be told, so the
 * client must see `internal`. These tests run a real `createServer` and read what
 * gRPC, Connect, gRPC-Web and `server.localClient()` callers actually receive,
 * because an unvalidated number may be rewritten or rejected by the wire layer.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createErrorHandlerInterceptor } from "../../src/errorHandler.ts";

const SECRET = "hunter2-marker";

/** Values a handler may carry in `code` that are not one of the codes 1..16. */
const outOfRange: Record<string, number> = {
    zero: 0,
    seventeen: 17,
    minusOne: -1,
    fraction: 1.5,
    fractionInsideRange: 16.5,
    notANumber: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    huge: 1e21,
    beyondSafeInteger: 2 ** 53,
    uint32Overflow: 2 ** 32 + 1,
    httpStatus: 404,
    errno: -2,
};

/** Every code a Connect failure may carry. */
const valid: Record<string, number> = {};
for (let code = Code.Canceled; code <= Code.Unauthenticated; code++) {
    valid[`code${code}`] = code;
}

const scenarios: Record<string, number> = { ...outOfRange, ...valid };

/** Request prefix that makes the handler throw a SanitizableError (clientMessage, serverDetails, code) instead of a plain error. */
const SANITIZABLE = "sanitizable:";
const CLIENT_MESSAGE = "safe text for the client";

function routes() {
    return defineService(EchoService, {
        echo: (req) => {
            const sanitizable = req.message.startsWith(SANITIZABLE);
            const code = scenarios[sanitizable ? req.message.slice(SANITIZABLE.length) : req.message];
            if (code === undefined) throw new ConnectError(`unknown scenario ${req.message}`, Code.InvalidArgument);
            const failure = new Error(`rule rejected ${SECRET}`);
            throw sanitizable ? Object.assign(failure, { clientMessage: CLIENT_MESSAGE, serverDetails: { secret: SECRET }, code }) : Object.assign(failure, { code });
        },
        secureEcho: () => ({ message: "unused" }),
        rateLimitedEcho: () => ({ message: "unused" }),
    });
}

async function failureOf(client: Client<typeof EchoService>, scenario: string): Promise<ConnectError> {
    try {
        await client.echo(create(EchoRequestSchema, { message: scenario }));
    } catch (err) {
        return ConnectError.from(err);
    }
    assert.fail(`scenario ${scenario} should have failed`);
}

describe("numeric code of a thrown value as seen by the client", () => {
    let server: Server;
    let clients: Record<string, Client<typeof EchoService>>;

    before(async () => {
        server = createServer({
            services: [routes()],
            interceptors: [createErrorHandlerInterceptor({ logErrors: false })],
            port: 0,
            allowHTTP1: false,
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        const baseUrl = `http://localhost:${port}`;
        clients = {
            grpc: createClient(EchoService, createGrpcTransport({ baseUrl })),
            connect: createClient(EchoService, createConnectTransport({ baseUrl, httpVersion: "2" })),
            grpcWeb: createClient(EchoService, createGrpcWebTransport({ baseUrl, httpVersion: "2" })),
            local: server.localClient(EchoService),
        };
    });

    after(async () => {
        await server.stop();
    });

    for (const transport of ["grpc", "connect", "grpcWeb", "local"]) {
        for (const [name, code] of Object.entries(outOfRange)) {
            it(`${transport}: code ${String(code)} (${name}) reaches the client as internal with the generic text`, async () => {
                const err = await failureOf(clients[transport]!, name);
                assert.strictEqual(err.code, Code.Internal, `observed code ${String(err.code)} text ${JSON.stringify(err.rawMessage)}`);
                assert.strictEqual(err.rawMessage, "internal error");
                assert.ok(!err.rawMessage.includes(SECRET), "text of the failure must not reach the client");
            });
        }

        for (const [name, code] of Object.entries(valid)) {
            it(`${transport}: code ${String(code)} (${name}) reaches the client unchanged without the text of the failure`, async () => {
                const err = await failureOf(clients[transport]!, name);
                assert.strictEqual(err.code, code);
                assert.strictEqual(err.rawMessage, code === Code.Internal ? "internal error" : "");
            });
        }

        // A SanitizableError chooses its client text, but a number that is not a failure code is
        // as unusable for it as for any other failure: the wire layer would answer `unknown`.
        for (const [name, code] of Object.entries(outOfRange)) {
            it(`${transport}: a SanitizableError with code ${String(code)} (${name}) reaches the client as internal with its clientMessage`, async () => {
                const err = await failureOf(clients[transport]!, `${SANITIZABLE}${name}`);
                assert.strictEqual(err.code, Code.Internal, `observed code ${String(err.code)} text ${JSON.stringify(err.rawMessage)}`);
                assert.strictEqual(err.rawMessage, CLIENT_MESSAGE);
                assert.ok(!JSON.stringify([err.rawMessage, err.metadata, err.details]).includes(SECRET), "server details must not reach the client");
            });
        }

        for (const [name, code] of Object.entries(valid)) {
            it(`${transport}: a SanitizableError with code ${String(code)} (${name}) reaches the client with that code and its clientMessage`, async () => {
                const err = await failureOf(clients[transport]!, `${SANITIZABLE}${name}`);
                assert.strictEqual(err.code, code);
                assert.strictEqual(err.rawMessage, CLIENT_MESSAGE);
            });
        }
    }
});

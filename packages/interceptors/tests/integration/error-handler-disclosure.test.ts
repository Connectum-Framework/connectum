/**
 * Error text disclosure through real transports.
 *
 * A handler exception that is not a ConnectError carries text such as a
 * connection string or a query. Oracle: CWE-209 (error messages must not expose
 * internals) and the Connect protocol documentation, under which such an
 * exception reaches the client as code `internal` with the generic text
 * "internal error". These tests run a real `createServer` and read what a gRPC
 * client, a Connect client and `server.localClient()` actually receive; a unit
 * test on the interceptor alone could not show that no transport adds the text back.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client, Interceptor } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";
import { createErrorHandlerInterceptor } from "../../src/errorHandler.ts";

const SECRET = "hunter2-marker";

const failures: Record<string, () => unknown> = {
    plainError: () => new Error(`db connect failed: password=${SECRET}`),
    stringThrown: () => `raw string with ${SECRET}`,
    numericCodeError: () => Object.assign(new Error(`rule admin-only rejected ${SECRET}`), { code: Code.PermissionDenied }),
};

function routes() {
    return defineService(EchoService, {
        echo: (req) => {
            const make = failures[req.message];
            if (!make) throw new ConnectError(`unknown scenario ${req.message}`, Code.InvalidArgument);
            throw make();
        },
        secureEcho: () => ({ message: "unused" }),
        rateLimitedEcho: () => ({ message: "unused" }),
    });
}

/** What a transport serializes for the error: text, details and metadata. */
function wireOf(err: ConnectError): string {
    return JSON.stringify({ message: err.rawMessage, details: err.details, metadata: [...err.metadata] });
}

async function failureOf(client: Client<typeof EchoService>, scenario: string): Promise<ConnectError> {
    try {
        await client.echo(create(EchoRequestSchema, { message: scenario }));
    } catch (err) {
        return ConnectError.from(err);
    }
    assert.fail(`scenario ${scenario} should have failed`);
}

/** Starts a server and returns one client per transport. */
async function startServer(interceptors: Interceptor[]) {
    const server = createServer({ services: [routes()], interceptors, port: 0, allowHTTP1: false });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "server must bind a port");
    const baseUrl = `http://localhost:${port}`;
    const clients: Record<string, Client<typeof EchoService>> = {
        grpc: createClient(EchoService, createGrpcTransport({ baseUrl })),
        connect: createClient(EchoService, createConnectTransport({ baseUrl, httpVersion: "2" })),
        local: server.localClient(EchoService),
    };
    return { server, clients };
}

describe("error text stays on the server (default chain)", () => {
    let server: Server;
    let clients: Record<string, Client<typeof EchoService>>;

    before(async () => {
        ({ server, clients } = await startServer(createDefaultInterceptors({ errorHandler: { logErrors: false } })));
    });

    after(async () => {
        await server.stop();
    });

    for (const transport of ["grpc", "connect", "local"]) {
        it(`${transport}: an Error becomes internal / "internal error" without its text`, async () => {
            const err = await failureOf(clients[transport]!, "plainError");
            assert.strictEqual(err.code, Code.Internal);
            assert.strictEqual(err.rawMessage, "internal error");
            assert.ok(!wireOf(err).includes(SECRET), "secret must not reach the client");
        });

        it(`${transport}: a thrown string becomes internal / "internal error" without its text`, async () => {
            const err = await failureOf(clients[transport]!, "stringThrown");
            assert.strictEqual(err.code, Code.Internal);
            assert.strictEqual(err.rawMessage, "internal error");
            assert.ok(!wireOf(err).includes(SECRET), "secret must not reach the client");
        });

        it(`${transport}: an Error with a numeric code keeps the code and sends an empty text`, async () => {
            const err = await failureOf(clients[transport]!, "numericCodeError");
            assert.strictEqual(err.code, Code.PermissionDenied);
            assert.strictEqual(err.rawMessage, "");
            assert.ok(!wireOf(err).includes(SECRET), "secret must not reach the client");
        });
    }
});

describe("exposeErrorMessages: true sends the original text (opt-in)", () => {
    let server: Server;
    let clients: Record<string, Client<typeof EchoService>>;

    before(async () => {
        ({ server, clients } = await startServer([createErrorHandlerInterceptor({ exposeErrorMessages: true, logErrors: false })]));
    });

    after(async () => {
        await server.stop();
    });

    for (const transport of ["grpc", "connect", "local"]) {
        it(`${transport}: the original text reaches the client`, async () => {
            const err = await failureOf(clients[transport]!, "plainError");
            assert.strictEqual(err.code, Code.Internal);
            assert.strictEqual(err.rawMessage, `db connect failed: password=${SECRET}`);
        });
    }
});

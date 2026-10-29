/**
 * A failing `onError` callback over real transports.
 *
 * `onError` is a reporting hook (an error tracker, a metrics endpoint). Oracle: the
 * documented guarantee that a failure of a reporting hook does not change the
 * outcome of a call, so a gRPC, Connect, gRPC-Web or `localClient()` caller gets
 * exactly the error the handler threw, and the process never sees an unhandled
 * rejection from the hook.
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

type OnError = NonNullable<NonNullable<Parameters<typeof createErrorHandlerInterceptor>[0]>["onError"]>;

/** What a handler throws for each scenario named in the request message. */
const thrown: Record<string, () => unknown> = {
    connectError: () => new ConnectError("user 42 not found", Code.NotFound),
    sanitizable: () => Object.assign(new Error("internal db error"), { clientMessage: "safe text", serverDetails: { query: "SELECT 1" }, code: Code.Unavailable }),
};

function routes() {
    return defineService(EchoService, {
        echo: (req) => {
            const make = thrown[req.message];
            if (make === undefined) throw new ConnectError(`unknown scenario ${req.message}`, Code.InvalidArgument);
            throw make();
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

describe("a failing onError callback as seen by the client", () => {
    let server: Server;
    let clients: Record<string, Client<typeof EchoService>>;
    let onErrorImpl: OnError;
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
    };
    let previousListeners: NodeJS.UnhandledRejectionListener[] = [];

    before(async () => {
        // node:test installs its own listener that fails the whole file; this suite looks at the event itself.
        previousListeners = process.listeners("unhandledRejection");
        process.removeAllListeners("unhandledRejection");
        process.on("unhandledRejection", recordUnhandled);

        server = createServer({
            services: [routes()],
            interceptors: [createErrorHandlerInterceptor({ logErrors: false, onError: (info) => onErrorImpl(info) })],
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
        process.removeListener("unhandledRejection", recordUnhandled);
        for (const listener of previousListeners) process.on("unhandledRejection", listener);
    });

    for (const transport of ["grpc", "connect", "grpcWeb", "local"]) {
        it(`${transport}: an onError that throws leaves the handler's ConnectError untouched`, async () => {
            onErrorImpl = () => {
                throw new Error("metrics sink down");
            };

            const err = await failureOf(clients[transport]!, "connectError");

            assert.strictEqual(err.code, Code.NotFound);
            assert.strictEqual(err.rawMessage, "user 42 not found");
        });

        it(`${transport}: an onError that throws leaves a SanitizableError's client text and code untouched`, async () => {
            onErrorImpl = () => {
                throw new Error("metrics sink down");
            };

            const err = await failureOf(clients[transport]!, "sanitizable");

            assert.strictEqual(err.code, Code.Unavailable);
            assert.strictEqual(err.rawMessage, "safe text");
        });

        it(`${transport}: an async onError that rejects leaves the error and the process untouched`, async () => {
            onErrorImpl = async () => {
                throw new Error("async sink down");
            };
            unhandled.length = 0;

            const err = await failureOf(clients[transport]!, "connectError");
            // An unhandled rejection is reported after the microtask queue has drained.
            await new Promise((resolve) => setTimeout(resolve, 20));

            assert.strictEqual(err.code, Code.NotFound);
            assert.strictEqual(err.rawMessage, "user 42 not found");
            assert.deepStrictEqual(unhandled, [], "a rejection of onError must be handled");
        });
    }
});

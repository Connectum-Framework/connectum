/**
 * The fallback interceptor and a request that fails validation.
 *
 * A fallback value stands in for a failed dependency, a timeout or a bug. A request that
 * violates a protovalidate rule is a client error: the documented behaviour is that it is
 * rejected with `INVALID_ARGUMENT` before it reaches the handler. Enabling the fallback must
 * not turn that rejection into a successful response the caller cannot tell from a served one.
 *
 * Real `createServer` on h2c port 0, the shipped `createDefaultInterceptors` chain with
 * validation at its default (on), and gRPC, Connect, gRPC-Web and `localClient()` callers.
 * The rule is the `buf.validate` annotation of the validated fixture (`message` is 3 to 50
 * characters), not a stand-in.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { CountSchema, EchoRequestSchema, EchoResponseSchema, ValidatedService } from "../../../testing/tests/fixtures/validated/pb/validated/v1/validated_pb.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";

const FALLBACK_MESSAGE = "FALLBACK-VALUE";
const REAL_MESSAGE = "REAL-RESPONSE";

describe("fallback and validation over real transports", () => {
    let server: Server;
    let clients: Record<string, Client<typeof ValidatedService>>;
    let handlerCalls = 0;
    let fallbackCalls = 0;
    // The handler fails for this message, so that a valid request can be answered by the fallback.
    const FAILING_REQUEST = "make-handler-fail";

    before(async () => {
        server = createServer({
            services: [
                defineService(ValidatedService, {
                    echo: (req) => {
                        handlerCalls++;
                        if (req.message === FAILING_REQUEST) {
                            throw new ConnectError("dependency down", Code.Unavailable);
                        }
                        return create(EchoResponseSchema, { message: REAL_MESSAGE });
                    },
                    collect: async () => create(CountSchema, { total: 0 }),
                }),
            ],
            interceptors: createDefaultInterceptors({
                errorHandler: { logErrors: false },
                fallback: {
                    handler: () => {
                        fallbackCalls++;
                        return create(EchoResponseSchema, { message: FALLBACK_MESSAGE });
                    },
                },
            }),
            port: 0,
            allowHTTP1: false,
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        const baseUrl = `http://localhost:${port}`;
        clients = {
            grpc: createClient(ValidatedService, createGrpcTransport({ baseUrl })),
            connect: createClient(ValidatedService, createConnectTransport({ baseUrl, httpVersion: "2" })),
            grpcWeb: createClient(ValidatedService, createGrpcWebTransport({ baseUrl, httpVersion: "2" })),
            local: server.localClient(ValidatedService),
        };
    });

    after(async () => {
        await server.stop();
    });

    for (const transport of ["grpc", "connect", "grpcWeb", "local"]) {
        it(`${transport}: a request that violates a rule is rejected with InvalidArgument, not answered by the fallback`, async () => {
            handlerCalls = 0;
            fallbackCalls = 0;

            const outcome = await clients[transport]!.echo(create(EchoRequestSchema, { message: "x" })).then(
                (res) => ({ ok: res.message }),
                (err: unknown) => ({ err: ConnectError.from(err) }),
            );

            assert.ok("err" in outcome, `the caller must get an error, got a response: ${JSON.stringify(outcome)}`);
            assert.strictEqual(outcome.err.code, Code.InvalidArgument);
            assert.match(outcome.err.rawMessage, /at least 3 characters/);
            assert.strictEqual(handlerCalls, 0, "the handler must not run for an invalid request");
            assert.strictEqual(fallbackCalls, 0, "the fallback handler must not be asked for a value");
        });

        it(`${transport}: a valid request is served by the handler`, async () => {
            handlerCalls = 0;
            fallbackCalls = 0;

            const res = await clients[transport]!.echo(create(EchoRequestSchema, { message: "hello" }));

            assert.strictEqual(res.message, REAL_MESSAGE);
            assert.strictEqual(handlerCalls, 1);
            assert.strictEqual(fallbackCalls, 0);
        });

        it(`${transport}: a failure of the handler is still answered by the fallback`, async () => {
            handlerCalls = 0;
            fallbackCalls = 0;

            const res = await clients[transport]!.echo(create(EchoRequestSchema, { message: FAILING_REQUEST }));

            assert.strictEqual(res.message, FALLBACK_MESSAGE);
            assert.strictEqual(handlerCalls, 1);
            assert.strictEqual(fallbackCalls, 1);
        });
    }
});

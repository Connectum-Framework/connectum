/**
 * Shutting a server down while a client keeps a reflection stream open.
 *
 * grpcurl in interactive mode, an IDE plugin and Postman leave a
 * `ServerReflectionInfo` call open after the last answer. `server.stop()` has
 * to end such a call with the other in-flight RPCs, not wait out
 * `shutdown.timeout` for a client that will never close it.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, type Server } from "@connectum/core";
import { ServerReflectionRequestSchema, ServerReflection as V1 } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { ServerReflection as V1alpha, ServerReflectionRequestSchema as V1alphaRequestSchema } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";

/** Long enough that waiting it out is unmistakable, short enough for a failing run to finish. */
const SHUTDOWN_TIMEOUT_MS = 8000;
/** A stop that was not held up by the stream finishes in milliseconds; this leaves room for a loaded machine. */
const STOP_BUDGET_MS = 3000;

const transports: Record<string, (server: Server) => Transport> = {
    http: (server) => createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }),
    "in-process": (server) => createLocalTransport(server),
};

for (const [transportName, transportOf] of Object.entries(transports)) {
    for (const version of ["v1", "v1alpha"] as const) {
        describe(`stop() with an open ${version} reflection stream over ${transportName}`, () => {
            async function withServer(run: (server: Server) => Promise<void>): Promise<void> {
                const server = createServer({
                    services: [],
                    port: 0,
                    protocols: [Reflection()],
                    interceptors: [],
                    allowHTTP1: false,
                    shutdown: { timeout: SHUTDOWN_TIMEOUT_MS },
                });
                await server.start();
                try {
                    await run(server);
                } finally {
                    if (server.isRunning) {
                        await server.stop();
                    }
                }
            }

            /** Opens a stream, reads the answer to one request and keeps the request side open. */
            async function openStream(server: Server) {
                const transport = transportOf(server);
                let release: () => void = () => {};
                const held = new Promise<void>((resolve) => {
                    release = resolve;
                });
                async function* requests() {
                    yield version === "v1"
                        ? create(ServerReflectionRequestSchema, { messageRequest: { case: "listServices", value: "" } })
                        : create(V1alphaRequestSchema, { messageRequest: { case: "listServices", value: "" } });
                    await held;
                }
                const responses = version === "v1" ? createClient(V1, transport).serverReflectionInfo(requests() as never) : createClient(V1alpha, transport).serverReflectionInfo(requests() as never);
                const iterator = (responses as AsyncIterable<{ messageResponse: { case?: string } }>)[Symbol.asyncIterator]();
                const first = await iterator.next();
                assert.strictEqual(first.done, false);
                assert.strictEqual(first.value.messageResponse.case, "listServicesResponse");
                // What the client sees after the first answer: how the call ends, if it does.
                const outcome = (async () => {
                    try {
                        for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
                            // further answers are not expected
                        }
                        return "ended" as const;
                    } catch (error) {
                        return error;
                    }
                })();
                return { outcome, release };
            }

            it("returns within a fraction of shutdown.timeout and ends the call", async () => {
                await withServer(async (server) => {
                    const stream = await openStream(server);
                    const warnings: unknown[] = [];
                    server.on("error", (error) => warnings.push(error));

                    const startedAt = Date.now();
                    await server.stop();
                    const stopMs = Date.now() - startedAt;
                    stream.release();

                    assert.ok(stopMs < STOP_BUDGET_MS, `stop() took ${stopMs} ms with a reflection stream open; shutdown.timeout is ${SHUTDOWN_TIMEOUT_MS} ms`);
                    assert.deepStrictEqual(warnings, [], "a stream open at shutdown is not an error of the shutdown");
                    assert.strictEqual(await stream.outcome, "ended", "the client's call must end with the shutdown, normally");
                });
            });
        });
    }
}

/**
 * Hand-written reflection servers for the `proto sync` tests. Their listing can disagree with
 * what they can describe, and one of them never answers, which a real Reflection() mount never does.
 */

import { createServer as createHttp2Server, type Http2Server, type Http2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { type DescFile, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ServerReflection } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";

const fixtureFile = FixtureService.file;
const fixtureFileBytes = toBinary(FileDescriptorProtoSchema, fixtureFile.proto);

/** Every file the fixture service file imports, directly or not, served by name when the client asks for it. */
const importedFiles = new Map<string, Uint8Array>();
const collectImports = (file: DescFile): void => {
    for (const dependency of file.dependencies) {
        if (!importedFiles.has(dependency.proto.name)) {
            importedFiles.set(dependency.proto.name, toBinary(FileDescriptorProtoSchema, dependency.proto));
            collectImports(dependency);
        }
    }
};
collectImports(fixtureFile);

const sessionsOf = new Map<Http2Server, Set<Http2Session>>();

/** Starts `server` on a free loopback port and returns its `http://` address. */
export function listen(server: Http2Server): Promise<string> {
    const sessions = new Set<Http2Session>();
    sessionsOf.set(server, sessions);
    server.on("session", (session) => {
        sessions.add(session);
        session.on("close", () => sessions.delete(session));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });
}

/** Http2Server has no closeAllConnections: sessions that never finish (the silent server's) are destroyed by hand. */
export function close(server: Http2Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
        for (const session of sessionsOf.get(server) ?? []) {
            session.destroy();
        }
    });
}

/**
 * A reflection server that lists three services but can describe only the fixture one:
 * the second answers with an error, the third with an empty file list.
 */
export function partialReflectionServer(): Http2Server {
    return createHttp2Server(
        connectNodeAdapter({
            routes: (router) => {
                router.service(ServerReflection, {
                    async *serverReflectionInfo(requests) {
                        for await (const request of requests) {
                            const message = request.messageRequest;
                            if (message.case === "listServices") {
                                yield {
                                    messageResponse: {
                                        case: "listServicesResponse",
                                        value: { service: [{ name: "fixture.v1.FixtureService" }, { name: "ghost.v1.GhostService" }, { name: "empty.v1.EmptyService" }] },
                                    },
                                };
                            } else if (message.case === "fileContainingSymbol" && message.value === "fixture.v1.FixtureService") {
                                yield { messageResponse: { case: "fileDescriptorResponse", value: { fileDescriptorProto: [fixtureFileBytes] } } };
                            } else if (message.case === "fileContainingSymbol" && message.value === "empty.v1.EmptyService") {
                                yield { messageResponse: { case: "fileDescriptorResponse", value: { fileDescriptorProto: [] } } };
                            } else if (message.case === "fileByFilename" && importedFiles.has(message.value)) {
                                yield { messageResponse: { case: "fileDescriptorResponse", value: { fileDescriptorProto: [importedFiles.get(message.value) as Uint8Array] } } };
                            } else {
                                // The reflection protocol reports a missing symbol inside the stream, not as a call status.
                                yield { messageResponse: { case: "errorResponse", value: { errorCode: Code.NotFound, errorMessage: `not found: ${message.value}` } } };
                            }
                        }
                    },
                });
            },
        }),
    );
}

/** A valid answer to a service listing; a fresh object per call, as the handler types want mutable arrays. */
function listServicesAnswer() {
    return { messageResponse: { case: "listServicesResponse" as const, value: { service: [{ name: "fixture.v1.FixtureService" }] } } };
}

/** A reflection server that answers every request with two responses, which the protocol forbids. */
export function twoResponsesServer(): Http2Server {
    return createHttp2Server(
        connectNodeAdapter({
            routes: (router) => {
                router.service(ServerReflection, {
                    async *serverReflectionInfo(requests) {
                        for await (const _request of requests) {
                            yield listServicesAnswer();
                            yield listServicesAnswer();
                        }
                    },
                });
            },
        }),
    );
}

/**
 * A reflection server that answers a request and then keeps the response stream open: it waits
 * for the client to give up (the time limit resets the stream) instead of ending the stream.
 */
export function neverEndingStreamServer(): Http2Server {
    return createHttp2Server(
        connectNodeAdapter({
            routes: (router) => {
                router.service(ServerReflection, {
                    async *serverReflectionInfo(requests, context) {
                        for await (const _request of requests) {
                            yield listServicesAnswer();
                        }
                        await new Promise<void>((resolve) => {
                            if (context.signal.aborted) {
                                resolve();
                                return;
                            }
                            context.signal.addEventListener("abort", () => resolve(), { once: true });
                        });
                    },
                });
            },
        }),
    );
}

/** Accepts the HTTP/2 connection and every stream on it, and never sends a byte back. */
export function silentServer(): Http2Server {
    const server = createHttp2Server();
    // The client resets the stream when its time limit passes; the reset surfaces here as an error that must not go unhandled.
    server.on("stream", (stream) => {
        stream.on("error", () => {});
    });
    return server;
}

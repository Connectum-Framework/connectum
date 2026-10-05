/**
 * `proto sync` must either obtain a descriptor for every service the server lists or fail
 * with a non-zero exit and name what is missing, and it must give up on a server that never
 * answers. The servers here are hand-written reflection servers so the listing can disagree
 * with what the server can describe, which a real Reflection() mount never does.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttp2Server, type Http2Server, type Http2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type DescFile, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ServerReflection } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { executeProtoSync } from "../../src/commands/proto-sync.ts";
import { fetchFileDescriptorSetBinary, fetchReflectionData } from "../../src/utils/reflection.ts";

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

function listen(server: Http2Server): Promise<string> {
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
function close(server: Http2Server): Promise<void> {
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
function partialReflectionServer(): Http2Server {
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

/** Accepts the HTTP/2 connection and every stream on it, and never sends a byte back. */
function silentServer(): Http2Server {
    const server = createHttp2Server();
    // The client resets the stream when its time limit passes; the reset surfaces here as an error that must not go unhandled.
    server.on("stream", (stream) => {
        stream.on("error", () => {});
    });
    return server;
}

describe("proto sync completeness and time limit", () => {
    let partial: Http2Server;
    let partialUrl: string;
    let silent: Http2Server;
    let silentUrl: string;
    let workdir: string;

    before(async () => {
        partial = partialReflectionServer();
        partialUrl = await listen(partial);
        silent = silentServer();
        silentUrl = await listen(silent);
        workdir = mkdtempSync(join(tmpdir(), "connectum-sync-complete-"));
    });

    after(async () => {
        await close(partial);
        await close(silent);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("names every listed service that has no descriptor, in the registry fetch", async () => {
        await assert.rejects(
            () => fetchReflectionData(partialUrl),
            (err: Error) => /ghost\.v1\.GhostService/.test(err.message) && /empty\.v1\.EmptyService/.test(err.message) && !/FixtureService/.test(err.message),
        );
    });

    it("fails the binary descriptor-set fetch the same way", async () => {
        await assert.rejects(() => fetchFileDescriptorSetBinary(partialUrl), /ghost\.v1\.GhostService/);
    });

    it("fails a full sync before buf runs, so nothing is generated", async () => {
        const out = join(workdir, "full-out");
        await assert.rejects(() => executeProtoSync({ from: partialUrl, out }), /ghost\.v1\.GhostService/);
        assert.equal(existsSync(out), false);
    });

    it("fails a dry run with the same error", async () => {
        await assert.rejects(() => executeProtoSync({ from: partialUrl, out: join(workdir, "dry-out"), dryRun: true }), /empty\.v1\.EmptyService/);
    });

    it("gives up on a server that accepts the connection and never answers", async () => {
        const started = Date.now();
        await assert.rejects(
            () => fetchReflectionData(silentUrl, { timeoutMs: 500 }),
            (err: Error) => err.message.includes(silentUrl) && err.message.includes("500 ms"),
        );
        assert.ok(Date.now() - started < 5000, "the 500 ms limit must end the call within seconds");
    });

    it("applies the time limit to a full sync as well", async () => {
        await assert.rejects(() => executeProtoSync({ from: silentUrl, out: join(workdir, "silent-out"), timeoutMs: 300 }), /300 ms/);
    });
});

describe("proto sync --timeout validation", () => {
    for (const bad of [0, -5, 1.5, Number.NaN, 2 ** 31]) {
        it(`rejects ${bad} without opening a connection`, async () => {
            await assert.rejects(() => executeProtoSync({ from: "127.0.0.1:1", out: "unused", timeoutMs: bad }), /--timeout must be a positive integer/);
        });
    }
});

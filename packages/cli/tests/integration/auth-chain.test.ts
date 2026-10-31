/**
 * The interceptor chain that `connectum init --auth` writes (`src/auth.ts`), run for real.
 *
 * The generated module is executed as it is generated, on a real server, with only its import
 * specifiers pointed at the workspace sources (a project would resolve them from node_modules) and
 * the sample service replaced by a fixture service. What it decides is observed from outside: the
 * HTTP/2 answer to the gRPC Health call and the reflection calls, the exact requests that `proto
 * sync` and health probes make, and the refusal of a method nobody opened.
 *
 * A text comparison cannot tell a rule that works from one that is merely present. Before this
 * test existed the generated chain listed the Health and reflection services as skipped by the JWT
 * interceptor but gave the deny-by-default authorizer no rule for them, so both answered
 * `unauthenticated`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import {
    // biome-ignore lint/suspicious/noDeprecatedImports: the v1alpha reflection service is still served by the framework and spoken by older tools, so the chain must leave it open as well.
    ServerReflectionRequestSchema as V1alphaRequestSchema,
    // biome-ignore lint/suspicious/noDeprecatedImports: see above.
    ServerReflection as V1alphaServerReflection,
} from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { generateAuthFile } from "../../src/scaffold/authFragment.ts";
import { fetchReflectionData } from "../../src/utils/reflection.ts";

const authSources = fileURLToPath(new URL("../../../auth/src/", import.meta.url));
const fixtureService = fileURLToPath(new URL("../../../reflection/tests/fixtures/fixture/v1/service_pb.ts", import.meta.url));
/** Gitignored scratch area of the repository, so no test writes outside it. */
const scratchRoot = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));

/** What the generated module is written against; each specifier is replaced by the workspace file that provides it. */
const SPECIFIERS: ReadonlyArray<readonly [specifier: string, replacement: string]> = [
    ['"@connectum/auth/proto"', JSON.stringify(pathToFileURL(`${authSources}proto/index.ts`).href)],
    ['"@connectum/auth"', JSON.stringify(pathToFileURL(`${authSources}index.ts`).href)],
    // The sample service of a project is replaced by a service that is mounted here.
    ['"#gen/greeter/v1/greeter_pb.ts"', JSON.stringify(`data:text/javascript,${encodeURIComponent(`export { FixtureService as GreeterService } from ${JSON.stringify(pathToFileURL(fixtureService).href)};`)}`)],
];

/** Writes the generated `src/auth.ts` into `dir`, with its specifiers pointed at the workspace, and returns the path. */
function writeRunnableAuthModule(dir: string, source: string): string {
    let runnable = source;
    for (const [specifier, replacement] of SPECIFIERS) {
        assert.ok(runnable.includes(specifier), `the generated module no longer imports ${specifier}; the test must follow it:\n${source}`);
        runnable = runnable.replaceAll(specifier, replacement);
    }
    const path = join(dir, "auth.ts");
    writeFileSync(path, runnable);
    return path;
}

/** One unary Connect-protocol (JSON) call over cleartext HTTP/2, the way `curl --http2-prior-knowledge` makes it. */
function unaryJson(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const session = connect(`http://127.0.0.1:${port}`);
        session.on("error", reject);
        const request = session.request({ ":method": "POST", ":path": path, "content-type": "application/json" });
        let status = 0;
        let body = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => {
            status = Number(headers[":status"]);
        });
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            session.close();
            resolve({ status, body });
        });
        request.on("error", reject);
        request.end("{}");
    });
}

describe("the generated --auth chain, on a real server", () => {
    let server: Server;
    let port: number;
    let workdir: string;

    before(async () => {
        mkdirSync(scratchRoot, { recursive: true });
        workdir = mkdtempSync(join(scratchRoot, "auth-chain-"));
        const modulePath = writeRunnableAuthModule(workdir, generateAuthFile({ healthcheck: true, reflection: true }));
        const { buildAuthInterceptors } = (await import(pathToFileURL(modulePath).href)) as { buildAuthInterceptors: () => Interceptor[] };

        const fixture = defineService(FixtureService, {
            get: () => ({}),
            ping: () => ({}),
        });
        server = createServer({
            services: [fixture],
            port: 0,
            host: "127.0.0.1",
            allowHTTP1: false,
            protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
            interceptors: buildAuthInterceptors(),
        });
        await server.start();
        // The process entry of a project does the same once the server is ready.
        healthcheckManager.update(ServingStatus.SERVING);
        port = server.address?.port as number;
        assert.ok(port, "the server must have an assigned port");
    });

    after(async () => {
        await server?.stop();
        if (workdir) {
            rmSync(workdir, { recursive: true, force: true });
        }
    });

    it("answers the gRPC Health call without credentials", async () => {
        const answer = await unaryJson(port, "/grpc.health.v1.Health/Check");

        assert.equal(answer.status, 200, answer.body);
        assert.deepEqual(JSON.parse(answer.body), { status: "SERVING" });
    });

    it("lets the reflection client of `proto sync` list and describe the services without credentials", async () => {
        const result = await fetchReflectionData(`http://127.0.0.1:${port}`);

        assert.ok(result.services.includes("grpc.health.v1.Health"), result.services.join(", "));
        assert.ok(result.services.includes("fixture.v1.FixtureService"), result.services.join(", "));
    });

    it("lets a v1alpha reflection client list the services without credentials", async () => {
        const transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` });
        const client = createClient(V1alphaServerReflection, transport);
        const request = create(V1alphaRequestSchema, { messageRequest: { case: "listServices", value: "" } });

        const answers = [];
        for await (const answer of client.serverReflectionInfo(
            (async function* () {
                yield request;
            })(),
        )) {
            answers.push(answer);
        }

        assert.equal(answers.length, 1);
        const message = answers[0]?.messageResponse;
        assert.equal(message?.case, "listServicesResponse", JSON.stringify(message));
        assert.ok(message.value.service.some((service) => service.name === "grpc.health.v1.Health"));
    });

    it("still refuses a method nobody opened: the chain stays deny-by-default", async () => {
        const answer = await unaryJson(port, "/fixture.v1.FixtureService/Ping");

        assert.equal(answer.status, 401, answer.body);
        assert.equal(JSON.parse(answer.body).code, "unauthenticated");
    });
});

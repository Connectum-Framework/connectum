/**
 * Interoperability with real reflection clients: grpcurl and `buf curl`.
 *
 * These clients are the reason the protocol details matter: grpcurl resolves
 * `describe pkg.Svc.Method` through file_containing_symbol, both expect the
 * imports of a file in the same answer, and both build request and response
 * codecs only from what reflection returns. Each case fails if the server's
 * answers are not enough for the client to list, describe or call the fixture
 * service.
 *
 * Not part of `pnpm test`: it needs Docker (grpcurl runs from the
 * `fullstorydev/grpcurl` image, host network) and the `buf` binary from this
 * package's devDependencies. Run from the package directory:
 *
 *     pnpm test:interop
 *
 * Containers run with `--rm`; remove the image afterwards with
 * `docker rmi fullstorydev/grpcurl:v1.9.3` if it is not wanted locally.
 */

import assert from "node:assert";
import { execFile } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer, defineService, type Server } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "../../src/Reflection.ts";
import { Level, MetaSchema } from "../fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../fixtures/fixture/v1/service_pb.ts";

const run = promisify(execFile);
const GRPCURL_IMAGE = "fullstorydev/grpcurl:v1.9.3";

const fixtureService = defineService(FixtureService, {
    get: (request) =>
        create(MetaSchema, {
            level: Level.HIGH,
            labels: { key: request.key.case === "id" ? request.key.value : "none" },
        }),
    ping: () => ({}),
});

describe("reflection interop with real clients", () => {
    let server: Server;
    let address: string;

    before(async () => {
        server = createServer({ services: [fixtureService], port: 0, protocols: [Healthcheck(), Reflection()], interceptors: [], allowHTTP1: false });
        await server.start();
        assert.ok(server.address?.port);
        address = `localhost:${server.address.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    async function grpcurl(...args: string[]): Promise<string> {
        const { stdout } = await run("docker", ["run", "--rm", "--network", "host", GRPCURL_IMAGE, "-plaintext", ...args]);
        return stdout;
    }

    async function bufCurl(...args: string[]): Promise<string> {
        const { stdout } = await run("buf", ["curl", "--protocol", "grpc", "--http2-prior-knowledge", ...args]);
        return stdout;
    }

    describe("grpcurl", () => {
        it("lists the services", async () => {
            assert.deepStrictEqual((await grpcurl(address, "list")).trim().split("\n"), ["fixture.v1.FixtureService", "grpc.health.v1.Health"]);
        });

        it("describes a service, including a custom method option", async () => {
            const output = await grpcurl(address, "describe", "fixture.v1.FixtureService");
            assert.match(output, /fixture\.v1\.FixtureService is a service:/);
            assert.match(output, /rpc Get \( \.fixture\.v1\.GetRequest \) returns \( \.fixture\.v1\.Meta \)/);
            // grpcurl prints the option with its fully-qualified, dot-prefixed name.
            assert.match(output, /option \(\.fixture\.v1\.audit\) = "read";/);
        });

        it("describes a method", async () => {
            assert.match(await grpcurl(address, "describe", "fixture.v1.FixtureService.Get"), /fixture\.v1\.FixtureService\.Get is a method:/);
        });

        it("describes a message, a field and an enum", async () => {
            assert.match(await grpcurl(address, "describe", "fixture.v1.GetRequest"), /oneof key \{/);
            assert.match(await grpcurl(address, "describe", "fixture.v1.Meta.labels"), /fixture\.v1\.Meta\.labels is a field:/);
            assert.match(await grpcurl(address, "describe", "fixture.v1.Level"), /fixture\.v1\.Level is an enum:/);
        });

        it("calls a method using only reflection for the schema", async () => {
            const output = await grpcurl("-d", '{"id":"x"}', address, "fixture.v1.FixtureService/Get");
            assert.deepStrictEqual(JSON.parse(output), { labels: { key: "x" }, level: "LEVEL_HIGH" });
        });
    });

    describe("buf curl", () => {
        it("lists the methods", async () => {
            const methods = (await bufCurl("--list-methods", `http://${address}`)).trim().split("\n");
            assert.deepStrictEqual(methods.sort(), [
                "fixture.v1.FixtureService/Get",
                "fixture.v1.FixtureService/Ping",
                "grpc.health.v1.Health/Check",
                "grpc.health.v1.Health/List",
                "grpc.health.v1.Health/Watch",
            ]);
        });

        it("calls a method using only reflection for the schema", async () => {
            const output = await bufCurl("-d", '{"id":"y"}', `http://${address}/fixture.v1.FixtureService/Get`);
            assert.deepStrictEqual(JSON.parse(output), { labels: { key: "y" }, level: "LEVEL_HIGH" });
        });
    });
});

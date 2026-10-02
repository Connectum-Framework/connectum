/**
 * The gRPC Health protocol, checked by the clients that consume it in practice.
 *
 * grpcurl (grpc-go) stands in for an operator, and grpc_health_probe is what a
 * Kubernetes exec probe or a container healthcheck runs. Neither is built on
 * Connect, so a server that our own Connect client accepts but these reject
 * fails here. The application changes statuses through the manager, its real
 * API; every assertion is about what the clients receive over HTTP/2.
 *
 * Not part of `pnpm test`: it needs Docker and the tools image. Run from the
 * repository root, then from this package:
 *
 *     node scripts/interop-tools.mjs
 *     pnpm test:interop
 *
 * The clients reach the server through the host network, which Docker offers
 * on Linux only; grpc_health_probe in the image is a linux-amd64 binary.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer, defineService, type Server } from "@connectum/core";
import { PROTO_DIR, parseJsonStream, runTool, startTool } from "../../../../tests/interop/tools.ts";
// The core package's test fixture: the healthcheck package ships no proto of
// its own besides Health, and the server needs an application service.
import { EchoResponseSchema, EchoService } from "../../../core/tests/fixtures/echo/v1/echo_pb.ts";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

/**
 * grpc_health_probe exit codes, from the "Exit codes" table of its README for
 * the pinned release. The README advises against relying on specific codes;
 * the version is pinned, and telling 3 from 4 is the point: 4 proves the RPC
 * succeeded and carried a non-SERVING status, 3 that the RPC itself failed.
 */
const PROBE_SERVING = 0;
const PROBE_RPC_FAILED = 3;
const PROBE_NOT_SERVING = 4;

describe("health with external clients", () => {
    let server: Server;
    let address: string;
    const manager = createHealthcheckManager();

    before(async () => {
        server = createServer({
            services: [echo],
            port: 0,
            protocols: [Healthcheck({ manager, watchInterval: 50 })],
            interceptors: [],
            allowHTTP1: false,
        });
        await server.start();
        assert.ok(server.address?.port);
        address = `127.0.0.1:${server.address.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    // The server has no reflection here, so grpcurl takes the Health schema
    // from the upstream health.proto (grpc/grpc-proto), not from this package.
    const UPSTREAM_HEALTH = ["-plaintext", "-import-path", PROTO_DIR, "-proto", "grpc/health/v1/health.proto"];

    async function grpcurl(...args: string[]): Promise<unknown> {
        const result = await runTool("grpcurl", [...UPSTREAM_HEALTH, ...args]);
        assert.strictEqual(result.code, 0, `grpcurl ${args.join(" ")} exited with ${result.code}: ${result.stderr}`);
        return JSON.parse(result.stdout);
    }

    describe("grpcurl", () => {
        it("reports the overall status and a tracked service's status", async () => {
            manager.update(ServingStatus.SERVING);
            assert.deepStrictEqual(await grpcurl(address, "grpc.health.v1.Health/Check"), { status: "SERVING" });
            assert.deepStrictEqual(await grpcurl("-d", `{"service":"${EchoService.typeName}"}`, address, "grpc.health.v1.Health/Check"), { status: "SERVING" });
        });

        it("answers NotFound for a service it does not track", async () => {
            const result = await runTool("grpcurl", [...UPSTREAM_HEALTH, "-d", '{"service":"no.such.Service"}', address, "grpc.health.v1.Health/Check"]);
            assert.notStrictEqual(result.code, 0);
            assert.match(result.stderr, /Code: NotFound/);
        });

        it("lists the tracked services with their statuses", async () => {
            manager.update(ServingStatus.SERVING);
            assert.deepStrictEqual(await grpcurl(address, "grpc.health.v1.Health/List"), {
                statuses: { [EchoService.typeName]: { status: "SERVING" } },
            });
        });

        it("streams a status change to a watcher", async () => {
            manager.update(ServingStatus.SERVING);
            const watch = startTool("grpcurl", [...UPSTREAM_HEALTH, "-max-time", "10", "-d", `{"service":"${EchoService.typeName}"}`, address, "grpc.health.v1.Health/Watch"]);
            const serving = { status: "SERVING" };
            const notServing = { status: "NOT_SERVING" };
            try {
                assert.deepStrictEqual(await watch.messages(1, 15_000), [serving], "the watcher first receives the current status");
                manager.update(ServingStatus.NOT_SERVING, EchoService.typeName);
                assert.deepStrictEqual(await watch.messages(2, 15_000), [serving, notServing], "then the change");
                manager.update(ServingStatus.SERVING, EchoService.typeName);
                assert.deepStrictEqual(await watch.messages(3, 15_000), [serving, notServing, serving], "and the change back");
            } finally {
                manager.update(ServingStatus.SERVING);
            }
            // The stream stays open until grpcurl's -max-time ends it. health.proto
            // lets a Watch end with any status, OK included (grpc-go's own server
            // answers CANCELLED); what matters is that nothing else arrives.
            const result = await watch.done;
            assert.deepStrictEqual(parseJsonStream(result.stdout), [serving, notServing, serving], "no message without a status change");
        });

        // health.proto: for an unknown service the server sends SERVICE_UNKNOWN
        // and keeps the call open, then sends the status once the service is known.
        it("keeps watching a service that is not known yet and reports it once it is", async () => {
            const watch = startTool("grpcurl", [...UPSTREAM_HEALTH, "-max-time", "10", "-d", '{"service":"late-component"}', address, "grpc.health.v1.Health/Watch"]);
            try {
                assert.deepStrictEqual(await watch.messages(1, 15_000), [{ status: "SERVICE_UNKNOWN" }]);
                manager.register("late-component", ServingStatus.SERVING);
                assert.deepStrictEqual(await watch.messages(2, 15_000), [{ status: "SERVICE_UNKNOWN" }, { status: "SERVING" }]);
            } finally {
                manager.unregister("late-component");
            }
            await watch.done;
        });
    });

    describe("grpc_health_probe", () => {
        async function probe(...args: string[]): Promise<number> {
            const result = await runTool("grpc_health_probe", [`-addr=${address}`, ...args]);
            return result.code;
        }

        it("succeeds while the server is SERVING", async () => {
            manager.update(ServingStatus.SERVING);
            assert.strictEqual(await probe(), PROBE_SERVING);
            assert.strictEqual(await probe(`-service=${EchoService.typeName}`), PROBE_SERVING);
        });

        it("fails with the not-serving code once the application reports NOT_SERVING", async () => {
            manager.update(ServingStatus.NOT_SERVING);
            try {
                assert.strictEqual(await probe(), PROBE_NOT_SERVING);
            } finally {
                manager.update(ServingStatus.SERVING);
            }
        });

        it("fails with the RPC-failure code for a service the server does not track", async () => {
            assert.strictEqual(await probe("-service=no.such.Service"), PROBE_RPC_FAILED);
        });
    });
});

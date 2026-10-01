/**
 * Health tracks the services that are mounted, not every service declared in
 * a mounted file.
 *
 * The fixture file declares two services; the server mounts one. Tracking the
 * other would make `List` report a service the server does not serve and
 * `Check` answer for it instead of NOT_FOUND, which the gRPC health protocol
 * reserves for unknown services.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { MountedService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("Healthcheck with a partly mounted file", () => {
    let server: Server;
    let baseUrl: string;

    before(async () => {
        const manager = createHealthcheckManager();
        server = createServer({
            services: [defineService(MountedService, { ping: () => ({}) })],
            port: 0,
            protocols: [Healthcheck({ manager })],
            interceptors: [],
            allowHTTP1: false,
        });
        await server.start();
        assert.ok(server.address?.port);
        baseUrl = `http://localhost:${server.address.port}`;
        manager.update(ServingStatus.SERVING);
    });

    after(async () => {
        await server?.stop();
    });

    it("lists only the mounted service", async () => {
        const client = createClient(Health, createGrpcTransport({ baseUrl }));
        const response = await client.list({});
        assert.deepStrictEqual(Object.keys(response.statuses), ["fixture.v1.MountedService"]);
    });

    it("answers NOT_FOUND for the unmounted service of the same file", async () => {
        const client = createClient(Health, createGrpcTransport({ baseUrl }));
        await assert.rejects(client.check({ service: "fixture.v1.UnmountedPeerService" }), (error: unknown) => {
            assert.ok(error instanceof ConnectError);
            assert.strictEqual(error.code, Code.NotFound);
            return true;
        });
    });
});

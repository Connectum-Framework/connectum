/**
 * Two servers with Healthcheck() in one process.
 *
 * Asked by a real network client of `grpc.health.v1.Health`, not through a
 * manager or an in-process client: the answer a probe gets is the contract.
 *
 * Without `manager`, every server shares the `healthcheckManager` singleton,
 * and starting the second server re-initializes it with only its own services,
 * so the first server stops being able to answer for its own. Giving each
 * server its own `createHealthcheckManager()` keeps them independent.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { MountedService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { Health, HealthCheckResponse_ServingStatus } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck, healthcheckManager } from "../../src/Healthcheck.ts";
import { createHealthcheckManager, type HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const FIRST_SERVICE = "fixture.v1.MountedService";
const SECOND_SERVICE = "fixture.v1.FixtureService";

function startFirst(manager?: HealthcheckManager): Server {
    return createServer({
        services: [defineService(MountedService, { ping: () => ({}) })],
        port: 0,
        protocols: [Healthcheck(manager === undefined ? {} : { manager })],
        interceptors: [],
        allowHTTP1: false,
    });
}

function startSecond(manager?: HealthcheckManager): Server {
    return createServer({
        services: [defineService(FixtureService, { ping: () => ({}), get: () => ({}) })],
        port: 0,
        protocols: [Healthcheck(manager === undefined ? {} : { manager })],
        interceptors: [],
        allowHTTP1: false,
    });
}

function healthClient(server: Server) {
    assert.ok(server.address?.port, "server must be listening");
    return createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address.port}` }));
}

async function statusOf(server: Server, service: string): Promise<HealthCheckResponse_ServingStatus | "NOT_FOUND"> {
    try {
        return (await healthClient(server).check({ service })).status;
    } catch (error) {
        if (error instanceof ConnectError && error.code === Code.NotFound) {
            return "NOT_FOUND";
        }
        throw error;
    }
}

describe("two servers with Healthcheck() in one process", () => {
    const running: Server[] = [];

    afterEach(async () => {
        for (const server of running.splice(0)) {
            await server.stop();
        }
        healthcheckManager.clear();
    });

    it("the shared singleton forgets the first server's service once the second starts", async () => {
        const first = startFirst();
        running.push(first);
        await first.start();
        healthcheckManager.update(ServingStatus.SERVING);
        assert.strictEqual(await statusOf(first, FIRST_SERVICE), HealthCheckResponse_ServingStatus.SERVING);

        const second = startSecond();
        running.push(second);
        await second.start();

        assert.strictEqual(await statusOf(first, FIRST_SERVICE), "NOT_FOUND");
        assert.strictEqual(await statusOf(first, ""), HealthCheckResponse_ServingStatus.NOT_SERVING);
    });

    it("a manager per server keeps each server's answers independent", async () => {
        const firstManager = createHealthcheckManager();
        const secondManager = createHealthcheckManager();

        const first = startFirst(firstManager);
        running.push(first);
        await first.start();
        firstManager.update(ServingStatus.SERVING);

        const second = startSecond(secondManager);
        running.push(second);
        await second.start();

        assert.strictEqual(await statusOf(first, FIRST_SERVICE), HealthCheckResponse_ServingStatus.SERVING);
        assert.strictEqual(await statusOf(first, ""), HealthCheckResponse_ServingStatus.SERVING);
        // The second server has not been marked ready yet: its own state is its own.
        assert.strictEqual(await statusOf(second, SECOND_SERVICE), HealthCheckResponse_ServingStatus.UNKNOWN);
        assert.strictEqual(await statusOf(second, FIRST_SERVICE), "NOT_FOUND");

        secondManager.update(ServingStatus.NOT_SERVING);
        assert.strictEqual(await statusOf(second, SECOND_SERVICE), HealthCheckResponse_ServingStatus.NOT_SERVING);
        assert.strictEqual(await statusOf(first, FIRST_SERVICE), HealthCheckResponse_ServingStatus.SERVING);

        await second.stop();
        assert.strictEqual(await statusOf(first, FIRST_SERVICE), HealthCheckResponse_ServingStatus.SERVING);
    });
});

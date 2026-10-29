/**
 * A server answers grpc.health.v1.Health from exactly one registration.
 *
 * Two Healthcheck() entries used to start without any error, and the
 * registration that happened to answer was the second one, silently ignoring
 * the first manager. Now the server refuses to build its routes with a message
 * that names the Health service.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer, defineService, type Server } from "@connectum/core";
import { EchoResponseSchema, EchoService } from "../../../core/tests/fixtures/echo/v1/echo_pb.ts";
import { Health, HealthCheckResponseSchema, HealthListResponseSchema } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

const NAMES_HEALTH = (err: unknown) => err instanceof Error && /Healthcheck\(\)/.test(err.message) && /grpc\.health\.v1\.Health/.test(err.message);

/** Run `body` and stop the server afterwards, whether the body passed or not. */
async function withServer(server: Server, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } finally {
        if (server.isRunning) {
            await server.stop();
        }
    }
}

describe("Healthcheck() registered more than once", () => {
    it("rejects start() when two registrations (two managers) are present", async () => {
        const server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ manager: createHealthcheckManager() }), Healthcheck({ manager: createHealthcheckManager() })],
        });

        await withServer(server, () => assert.rejects(() => server.start(), NAMES_HEALTH));
    });

    it("rejects start() when the application mounts its own Health service", async () => {
        const ownHealth = defineService(Health, {
            check: () => create(HealthCheckResponseSchema, { status: ServingStatus.SERVING }),
            list: () => create(HealthListResponseSchema, {}),
            // biome-ignore lint/correctness/useYield: an empty stream is all this stand-in needs
            async *watch() {},
        });
        const server = createServer({ services: [ownHealth], port: 0, protocols: [Healthcheck({ manager: createHealthcheckManager() })] });

        await withServer(server, () => assert.rejects(() => server.start(), NAMES_HEALTH));
    });

    it("rejects the first in-process client of a server with two registrations", async () => {
        const server = createServer({
            services: [echo],
            port: 0,
            protocols: [Healthcheck({ manager: createHealthcheckManager() }), Healthcheck({ manager: createHealthcheckManager() })],
        });

        await withServer(server, () => assert.rejects(async () => server.localClient(Health).check({ service: "" }), NAMES_HEALTH));
    });

    it("starts and answers with one registration next to other services", async () => {
        const manager = createHealthcheckManager();
        const server = createServer({ services: [echo], port: 0, protocols: [Healthcheck({ manager })], allowHTTP1: false });
        await server.start();
        await withServer(server, async () => {
            manager.update(ServingStatus.SERVING);
            const client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));

            assert.strictEqual((await client.check({ service: "" })).status, ServingStatus.SERVING);
        });
    });

    it("allows one registration object to be used by two separate servers", async () => {
        const protocol = Healthcheck({ manager: createHealthcheckManager() });
        const first = createServer({ services: [], port: 0, protocols: [protocol], allowHTTP1: false });
        const second = createServer({ services: [], port: 0, protocols: [protocol], allowHTTP1: false });
        await first.start();
        await withServer(first, async () => {
            await second.start();
            await withServer(second, async () => {
                assert.ok(second.isRunning);
            });
        });
    });
});

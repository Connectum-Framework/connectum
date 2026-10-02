/**
 * Healthcheck after a retried route materialization, as a client sees it.
 *
 * When the server's first route materialization throws (here: the first
 * in-process access, with a protocol listed after Healthcheck failing in
 * `setup`), `start()` later builds the routes again and calls Healthcheck's
 * `setup` again. That second call must see the application services only. If
 * the attempt that failed had left its mounted services behind, the retry would
 * hand Healthcheck its own `grpc.health.v1.Health`, which it would track as
 * UNKNOWN: a client listing the services would see Health among them, and
 * overall health could never reach SERVING.
 *
 * Every assertion goes through a Health client over HTTP/2 against the started
 * server, which is what a probe or an operator uses.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { ProtocolRegistration } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
// The core package's test fixture: the healthcheck package ships no proto of
// its own besides Health, and the test needs an application service.
import { EchoResponseSchema, EchoService } from "../../../core/tests/fixtures/echo/v1/echo_pb.ts";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

function failingOnceProtocol(): ProtocolRegistration {
    let calls = 0;
    return {
        name: "failing-once",
        setup() {
            calls++;
            if (calls === 1) {
                throw new Error("setup failed on the first attempt");
            }
        },
        register(_router: ConnectRouter) {},
    };
}

const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

describe("Healthcheck after a failed initial route materialization", () => {
    it("serves only the application services over HTTP after start() retries, and reaches SERVING", async () => {
        const manager = createHealthcheckManager();
        const server = createServer({
            services: [echo],
            port: 0,
            protocols: [Healthcheck({ manager }), failingOnceProtocol()],
            allowHTTP1: false,
        });

        assert.throws(() => server.localClient(EchoService), /setup failed on the first attempt/, "the first materialization must surface the setup error");

        await server.start();
        try {
            const health = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));

            const listed = await health.list({});
            assert.deepStrictEqual(Object.keys(listed.statuses), [EchoService.typeName], "a client must see only the application service, not grpc.health.v1.Health");

            await assert.rejects(
                health.check({ service: Health.typeName }),
                (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
                "the Health service must not be tracked after the retry",
            );

            manager.update(ServingStatus.SERVING);
            const overall = await health.check({ service: "" });
            assert.strictEqual(overall.status, ServingStatus.SERVING, "overall health must reach SERVING after the retry");
        } finally {
            await server.stop();
        }
    });
});

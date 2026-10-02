/**
 * Healthcheck after a retried route materialization.
 *
 * When the server's first route materialization throws (here: a protocol
 * listed after Healthcheck fails in `setup`), the next attempt builds the
 * routes again and calls Healthcheck's `setup` again. That second call must see
 * the application services only. If the attempt that failed had left its
 * mounted services behind, the retry would hand Healthcheck its own
 * `grpc.health.v1.Health`, which it would track as UNKNOWN, and overall health
 * could never reach SERVING.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
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
    it("tracks only the application services on the retry and reaches SERVING", async () => {
        const manager = createHealthcheckManager();
        const server = createServer({
            services: [echo],
            port: 0,
            protocols: [Healthcheck({ manager }), failingOnceProtocol()],
            allowHTTP1: false,
        });

        assert.throws(() => server.localClient(Health), /setup failed on the first attempt/, "the first materialization must surface the setup error");

        const health = server.localClient(Health);
        assert.deepStrictEqual([...manager.getAllStatuses().keys()], [EchoService.typeName], "the retry must not track grpc.health.v1.Health");

        manager.update(ServingStatus.SERVING);
        const overall = await health.check({ service: "" });
        assert.strictEqual(overall.status, ServingStatus.SERVING, "overall health must reach SERVING after the retry");
    });
});

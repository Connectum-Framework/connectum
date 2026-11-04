/**
 * The documented default, `[Healthcheck({ httpEnabled: true }), Reflection()]`
 * with one application service, answers what it answered before Healthcheck
 * began to complete its set in `ready`: `Reflection()` adds nothing to
 * `Health.List`, to the overall status or to `/healthz`.
 *
 * Asserted through the wire (HTTP `/healthz`, gRPC `Check` and `List`), with
 * the exact codes and bodies.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { EchoResponseSchema, EchoService } from "../../../core/tests/fixtures/echo/v1/echo_pb.ts";
import { Reflection } from "../../../reflection/src/Reflection.ts";
import { Health, HealthCheckResponse_ServingStatus } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager, type HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

describe("Healthcheck in the documented default configuration", () => {
    let server: Server;
    let manager: HealthcheckManager;
    let baseUrl: string;

    before(async () => {
        manager = createHealthcheckManager();
        server = createServer({ services: [echo], port: 0, protocols: [Healthcheck({ httpEnabled: true, manager }), Reflection()], interceptors: [], allowHTTP1: false });
        await server.start();
        assert.ok(server.address?.port);
        baseUrl = `http://localhost:${server.address.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    async function healthz(): Promise<{ status: number; body: unknown }> {
        // The listener is h2c only, so the probe speaks HTTP/2 like a gRPC client does.
        const { connect } = await import("node:http2");
        const session = connect(baseUrl);
        try {
            return await new Promise((resolve, reject) => {
                const req = session.request({ ":path": "/healthz" });
                let status = 0;
                let text = "";
                req.on("response", (headers) => {
                    status = Number(headers[":status"]);
                });
                req.setEncoding("utf8");
                req.on("data", (chunk: string) => {
                    text += chunk;
                });
                req.on("end", () => {
                    const body = JSON.parse(text) as Record<string, unknown>;
                    delete body.timestamp;
                    resolve({ status, body });
                });
                req.on("error", reject);
                req.end();
            });
        } finally {
            session.close();
        }
    }

    it("lists only the application service, with Check(\"\") and /healthz not serving before any update", async () => {
        const client = createClient(Health, createGrpcTransport({ baseUrl }));

        assert.deepStrictEqual(Object.keys((await client.list({})).statuses), [EchoService.typeName]);
        assert.strictEqual((await client.check({ service: "" })).status, HealthCheckResponse_ServingStatus.NOT_SERVING);
        assert.deepStrictEqual(await healthz(), { status: 503, body: { status: "NOT_SERVING", service: "overall" } });
    });

    it("reaches SERVING on update of the application service alone", async () => {
        const client = createClient(Health, createGrpcTransport({ baseUrl }));
        manager.update(ServingStatus.SERVING, EchoService.typeName);

        assert.strictEqual((await client.check({ service: "" })).status, HealthCheckResponse_ServingStatus.SERVING);
        assert.deepStrictEqual(await healthz(), { status: 200, body: { status: "SERVING", service: "overall" } });
    });
});

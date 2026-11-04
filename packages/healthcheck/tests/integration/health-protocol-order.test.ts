/**
 * The order of `protocols` does not change which services Health tracks.
 *
 * Healthcheck finishes its tracked set in the protocol `ready` hook, after every
 * protocol has registered. Asked by a network client of `grpc.health.v1.Health`
 * (what a probe or an operator uses), every ordering of the same protocols
 * therefore answers the same `List`, and `Check` answers for each tracked
 * service. Health never tracks its own service.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { ProtocolRegistration, Server } from "@connectum/core";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { EchoResponseSchema, EchoService } from "../../../core/tests/fixtures/echo/v1/echo_pb.ts";
import { Reflection } from "../../../reflection/src/Reflection.ts";
import { MetaSchema } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { Health, HealthCheckResponse_ServingStatus } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager, type HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

/** A protocol that mounts an application-style service of its own. */
function fixtureProtocol(): ProtocolRegistration {
    return {
        name: "fixture-protocol",
        register(router) {
            router.service(FixtureService, { get: () => create(MetaSchema, {}), ping: () => ({}) });
        },
    };
}

const REFLECTION_V1 = "grpc.reflection.v1.ServerReflection";
const REFLECTION_V1ALPHA = "grpc.reflection.v1alpha.ServerReflection";
const FIXTURE = "fixture.v1.FixtureService";

const EXPECTED_TRACKED = [EchoService.typeName, FIXTURE, REFLECTION_V1, REFLECTION_V1ALPHA].sort();

const ORDERS: Array<[string, (manager: HealthcheckManager) => ProtocolRegistration[]]> = [
    ["[Reflection, Healthcheck, fixture]", (manager) => [Reflection(), Healthcheck({ manager }), fixtureProtocol()]],
    ["[Healthcheck, Reflection, fixture]", (manager) => [Healthcheck({ manager }), Reflection(), fixtureProtocol()]],
    ["[Healthcheck, fixture, Reflection]", (manager) => [Healthcheck({ manager }), fixtureProtocol(), Reflection()]],
    ["[fixture, Reflection, Healthcheck]", (manager) => [fixtureProtocol(), Reflection(), Healthcheck({ manager })]],
];

describe("Healthcheck: the order of protocols does not change what is tracked", () => {
    const started = new Map<string, { server: Server; manager: HealthcheckManager; client: ReturnType<typeof createClient<typeof Health>> }>();

    before(async () => {
        for (const [name, make] of ORDERS) {
            // A manager per server: the default one is shared by every server of the process.
            const manager = createHealthcheckManager();
            const server = createServer({ services: [echo], port: 0, protocols: make(manager), interceptors: [], allowHTTP1: false });
            await server.start();
            assert.ok(server.address?.port, "the server must have an assigned port");
            const client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address.port}` }));
            started.set(name, { server, manager, client });
        }
    });

    after(async () => {
        for (const { server } of started.values()) {
            await server.stop();
        }
    });

    const at = (name: string) => {
        const entry = started.get(name);
        assert.ok(entry, `no server for ${name}`);
        return entry;
    };

    for (const [name] of ORDERS) {
        it(`${name}: List returns every other service and not Health`, async () => {
            const listed = await at(name).client.list({});
            assert.deepStrictEqual(Object.keys(listed.statuses).sort(), EXPECTED_TRACKED);

            // An in-process client builds its own router; it must see the same set.
            const local = await createClient(Health, createLocalTransport(at(name).server)).list({});
            assert.deepStrictEqual(Object.keys(local.statuses).sort(), EXPECTED_TRACKED, "in-process and HTTP clients must see the same tracked services");
        });

        it(`${name}: Check answers for each tracked service and NOT_FOUND for Health`, async () => {
            const { client, manager } = at(name);
            manager.update(ServingStatus.SERVING);

            for (const service of EXPECTED_TRACKED) {
                const response = await client.check({ service });
                assert.strictEqual(response.status, HealthCheckResponse_ServingStatus.SERVING, service);
            }
            assert.strictEqual((await client.check({ service: "" })).status, HealthCheckResponse_ServingStatus.SERVING, "overall health must reach SERVING");
            await assert.rejects(client.check({ service: Health.typeName }), (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound);
        });

        it(`${name}: a new tracked service starts as UNKNOWN`, async () => {
            // A fresh server of the same order: the statuses above were set to SERVING.
            const manager = createHealthcheckManager();
            const make = ORDERS.find(([n]) => n === name)?.[1];
            assert.ok(make);
            const server = createServer({ services: [echo], port: 0, protocols: make(manager), interceptors: [], allowHTTP1: false });
            await server.start();
            try {
                assert.ok(server.address?.port);
                const client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address.port}` }));
                const listed = await client.list({});
                for (const service of EXPECTED_TRACKED) {
                    assert.strictEqual(listed.statuses[service]?.status, HealthCheckResponse_ServingStatus.UNKNOWN, service);
                }
            } finally {
                await server.stop();
            }
        });
    }
});

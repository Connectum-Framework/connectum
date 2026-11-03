/**
 * The order of `protocols` does not change what reflection shows.
 *
 * Reflection collects its descriptors in the protocol `ready` hook, after every
 * protocol has registered. A client therefore sees the same services for
 * `[Reflection(), Healthcheck()]` and `[Healthcheck(), Reflection()]`, and a
 * protocol listed after Reflection is visible too. The listing is read both by
 * a protobuf-es client and by `buf curl --reflect`, an external client that
 * resolves the schema of a call through reflection alone.
 */

import assert from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, type ProtocolContext, type ProtocolRegistration, type Server } from "@connectum/core";
import { createHealthcheckManager, Healthcheck } from "@connectum/healthcheck";
import { ServerReflection, type ServerReflectionResponse } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";
import { MetaSchema } from "../fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../fixtures/fixture/v1/service_pb.ts";

const run = promisify(execFile);
const bufBinary = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin", "buf");

type Query = { case: "listServices" | "fileContainingSymbol"; value: string };

async function ask(transport: Transport, messageRequest: Query): Promise<ServerReflectionResponse> {
    async function* requests() {
        yield { messageRequest };
    }
    for await (const response of createClient(ServerReflection, transport).serverReflectionInfo(requests())) {
        return response;
    }
    throw new Error("the reflection stream ended without a response");
}

async function listServices(transport: Transport): Promise<string[]> {
    const response = await ask(transport, { case: "listServices", value: "" });
    assert.strictEqual(response.messageResponse.case, "listServicesResponse");
    return response.messageResponse.value.service.map((s) => s.name);
}

async function describeSymbol(transport: Transport, symbol: string): Promise<string[]> {
    const response = await ask(transport, { case: "fileContainingSymbol", value: symbol });
    assert.strictEqual(response.messageResponse.case, "fileDescriptorResponse", JSON.stringify(response.messageResponse));
    return response.messageResponse.value.fileDescriptorProto.map((bytes) => Buffer.from(bytes).toString("base64"));
}

/** Runs `buf curl` against `port`, resolving every schema through reflection. */
async function bufCurl(...args: string[]): Promise<string> {
    const { stdout } = await run(bufBinary, ["curl", "--protocol", "grpc", "--http2-prior-knowledge", "--reflect", ...args], { timeout: 60_000 });
    return stdout;
}

/** A protocol that mounts a service and records how often its hooks run. */
function fixtureProtocol(): ProtocolRegistration & { setups: number; readies: number; readyServices: string[] } {
    const state = {
        name: "fixture-protocol",
        setups: 0,
        readies: 0,
        readyServices: [] as string[],
        setup() {
            state.setups++;
        },
        ready(context: ProtocolContext) {
            state.readies++;
            state.readyServices = context.services.map((s) => s.typeName);
        },
        register(router: Parameters<ProtocolRegistration["register"]>[0]) {
            router.service(FixtureService, { get: () => create(MetaSchema, {}), ping: () => ({}) });
        },
    };
    return state;
}

const ORDERS: Array<[string, () => ProtocolRegistration[]]> = [
    // Each server gets its own health manager: the default one is shared by every server in the
    // process, and a second server's setup would rewrite what the first one tracks.
    ["[Reflection(), Healthcheck()]", () => [Reflection(), Healthcheck({ manager: createHealthcheckManager() })]],
    ["[Healthcheck(), Reflection()]", () => [Healthcheck({ manager: createHealthcheckManager() }), Reflection()]],
];

describe("Reflection: the order of protocols does not change what is shown", () => {
    const servers = new Map<string, { server: Server; port: number }>();

    before(async () => {
        assert.ok(existsSync(bufBinary), `buf is missing at ${bufBinary}: run pnpm install`);
        for (const [name, make] of ORDERS) {
            const server = createServer({ services: [], port: 0, protocols: make(), interceptors: [], allowHTTP1: false });
            await server.start();
            const port = server.address?.port;
            assert.ok(port, "the server must have an assigned port");
            servers.set(name, { server, port });
        }
    });

    after(async () => {
        for (const { server } of servers.values()) {
            await server.stop();
        }
    });

    const at = (name: string) => {
        const entry = servers.get(name);
        assert.ok(entry, `no server for ${name}`);
        return entry;
    };

    for (const [name] of ORDERS) {
        it(`${name}: lists the Health service and neither reflection service`, async () => {
            const { server, port } = at(name);
            const overHttp = await listServices(createGrpcTransport({ baseUrl: `http://localhost:${port}` }));

            assert.deepStrictEqual(overHttp, ["grpc.health.v1.Health"]);
            assert.deepStrictEqual(await listServices(createLocalTransport(server)), overHttp, "in-process and HTTP clients must see the same listing");
        });

        it(`${name}: buf curl --reflect lists the Health methods and calls Check`, async () => {
            const { port } = at(name);
            const methods = await bufCurl("--list-methods", `http://localhost:${port}`);
            assert.deepStrictEqual(
                methods
                    .split("\n")
                    .filter((line) => line !== "")
                    .sort(),
                ["grpc.health.v1.Health/Check", "grpc.health.v1.Health/List", "grpc.health.v1.Health/Watch"],
            );

            // Resolving the call's schema is a reflection describe of the service.
            const check = JSON.parse(await bufCurl("--data", "{}", `http://localhost:${port}/grpc.health.v1.Health/Check`)) as { status: string };
            assert.strictEqual(check.status, "NOT_SERVING");
        });
    }

    // Not changed by the ready hook: Healthcheck tracks the services registered before it, so
    // whether it tracks the reflection services still depends on the order. Pinned so that a
    // change of that rule is a deliberate decision.
    it("Health tracks only the services registered before Healthcheck", async () => {
        const tracked = async (name: string): Promise<string[]> => {
            const { port } = at(name);
            const list = JSON.parse(await bufCurl("--data", "{}", `http://localhost:${port}/grpc.health.v1.Health/List`)) as { statuses?: Record<string, unknown> };
            return Object.keys(list.statuses ?? {}).sort();
        };

        assert.deepStrictEqual(await tracked(ORDERS[0]?.[0] ?? ""), ["grpc.reflection.v1.ServerReflection", "grpc.reflection.v1alpha.ServerReflection"]);
        assert.deepStrictEqual(await tracked(ORDERS[1]?.[0] ?? ""), []);
    });

    it("both orders answer the same listing and the same describe", async () => {
        const [first, second] = ORDERS.map(([name]) => createGrpcTransport({ baseUrl: `http://localhost:${at(name).port}` }));
        assert.ok(first && second);

        assert.deepStrictEqual(await listServices(first), await listServices(second));
        assert.deepStrictEqual(await describeSymbol(first, "grpc.health.v1.Health"), await describeSymbol(second, "grpc.health.v1.Health"));
        assert.deepStrictEqual(
            await bufCurl("--list-methods", `http://localhost:${at(ORDERS[0]?.[0] ?? "").port}`),
            await bufCurl("--list-methods", `http://localhost:${at(ORDERS[1]?.[0] ?? "").port}`),
        );
    });
});

describe("Reflection: a protocol listed after Reflection is visible", () => {
    let server: Server;
    let port: number;
    let late: ReturnType<typeof fixtureProtocol>;

    before(async () => {
        late = fixtureProtocol();
        server = createServer({ services: [], port: 0, protocols: [Reflection(), Healthcheck(), late], interceptors: [], allowHTTP1: false });
        await server.start();
        const assigned = server.address?.port;
        assert.ok(assigned, "the server must have an assigned port");
        port = assigned;
    });

    after(async () => {
        await server?.stop();
    });

    it("lists the services of every other protocol, in registration order", async () => {
        const expected = ["grpc.health.v1.Health", "fixture.v1.FixtureService"];

        assert.deepStrictEqual(await listServices(createGrpcTransport({ baseUrl: `http://localhost:${port}` })), expected);
        assert.deepStrictEqual(await listServices(createLocalTransport(server)), expected);
    });

    it("lets buf curl call the service of the later protocol through reflection", async () => {
        const reply = JSON.parse(await bufCurl("--data", "{}", `http://localhost:${port}/fixture.v1.FixtureService/Ping`)) as unknown;
        assert.deepStrictEqual(reply, {});
    });

    it("runs the hooks of a protocol once, however many routers the server builds", async () => {
        // The in-process transport above built extra routers; none of them repeats setup or ready.
        assert.strictEqual(late.setups, 1);
        assert.strictEqual(late.readies, 1);
        // `ready` sees every service, the reflection ones and the protocol's own included.
        assert.deepStrictEqual(late.readyServices, ["grpc.reflection.v1.ServerReflection", "grpc.reflection.v1alpha.ServerReflection", "grpc.health.v1.Health", "fixture.v1.FixtureService"]);
    });
});

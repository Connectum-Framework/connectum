/**
 * Catalog calls that leave the process carry the caller's `outgoingInterceptors`.
 *
 * A caller `Server` with a bearer signer in `outgoingInterceptors` calls a
 * receiver `Server` over a real HTTP/2 socket. The receiver verifies the token
 * against a real JWKS endpoint. The receiver must see the verified subject on
 * `ctx.call` (unary) and on `server.client()` (server-stream); without the
 * chain, or with a token from an untrusted issuer, it must answer
 * `Unauthenticated` before any handler runs.
 *
 * The service is described at runtime from a `FileDescriptorProto`, so the test
 * needs no code generation.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, createFileRegistry, type DescMessage, type DescService, fromJson } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer, defineCatalog, defineService, type Server, singleTransportResolver } from "@connectum/core";
import { createClientBearerInterceptor } from "../../src/client-bearer-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwtRS256, generateRsaTestKeypair, startTestJwksServer, type TestJwksServer } from "../../src/testing/test-jwt-rs256.ts";
import type { ClientBearerInterceptorOptions } from "../../src/types.ts";

const ISSUER = "https://issuer.trusted.example";
const AUDIENCE = "probe-service";

const registry = createFileRegistry(
    fromJson(FileDescriptorSetSchema, {
        file: [{
        name: "authtest/v1/probe.proto",
        package: "authtest.v1",
        syntax: "proto3",
        messageType: [{ name: "Msg", field: [{ name: "value", number: 1, type: "TYPE_STRING", label: "LABEL_OPTIONAL", jsonName: "value" }] }],
        service: [
            {
                name: "Probe",
                method: [
                    { name: "Whoami", inputType: ".authtest.v1.Msg", outputType: ".authtest.v1.Msg" },
                    { name: "Count", inputType: ".authtest.v1.Msg", outputType: ".authtest.v1.Msg", serverStreaming: true },
                ],
            },
            { name: "Caller", method: [{ name: "Run", inputType: ".authtest.v1.Msg", outputType: ".authtest.v1.Msg" }] },
        ],
        }],
    }),
);

function mustGet<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`missing descriptor ${what}`);
    return value;
}

const Msg: DescMessage = mustGet(registry.getMessage("authtest.v1.Msg"), "Msg");
const Probe: DescService = mustGet(registry.getService("authtest.v1.Probe"), "Probe");
const Caller: DescService = mustGet(registry.getService("authtest.v1.Caller"), "Caller");

declare module "@connectum/core" {
    interface ConnectumCallMap {
        "authtest.v1.Probe/Whoami": { request: { value: string }; response: { value: string } };
    }
}

const catalog = defineCatalog({ [Probe.typeName]: Probe, [Caller.typeName]: Caller });

const msg = (value: string) => create(Msg, { value }) as unknown as { value: string };

let jwks: TestJwksServer;
let receiver: Server;
let receiverUrl: string;
let trustedKey: Awaited<ReturnType<typeof generateRsaTestKeypair>>;
let foreignKey: Awaited<ReturnType<typeof generateRsaTestKeypair>>;
const callers: Server[] = [];

async function tokenFor(key: typeof trustedKey, issuer: string, sub: string): Promise<string> {
    return createTestJwtRS256(key.privateKey, { sub }, { kid: key.kid, issuer, audience: AUDIENCE });
}

before(async () => {
    trustedKey = await generateRsaTestKeypair("trusted-key");
    foreignKey = await generateRsaTestKeypair("foreign-key");
    jwks = await startTestJwksServer(trustedKey.publicJwk);
    receiver = createServer({
        services: [
            defineService(Probe, {
                // The handler runs only after the receiver's JWT interceptor accepted the call.
                whoami: (req: { value: string }) => ({ value: `${req.value}:${getAuthContext()?.subject ?? "anonymous"}` }),
                async *count(req: { value: string }) {
                    for (let i = 0; i < 2; i++) yield { value: `${req.value}-${i}` };
                },
            } as never),
        ],
        interceptors: [createJwtAuthInterceptor({ jwksUri: jwks.url, issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256"] })],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
        shutdown: { timeout: 200 },
    });
    await receiver.start();
    receiverUrl = `http://127.0.0.1:${receiver.address?.port}`;
});

after(async () => {
    for (const caller of callers) await caller.stop().catch(() => undefined);
    await receiver.stop();
    await jwks.close();
});

/** A caller server with the given bearer chain; its `Run` handler does the `ctx.call`. */
function makeCaller(outgoing: ClientBearerInterceptorOptions[]): Server {
    const server = createServer({
        services: [
            defineService(Caller, {
                run: async (req: { value: string }, ctx: { call: (m: string, r: unknown) => Promise<{ value: string }> }) => ctx.call("authtest.v1.Probe/Whoami", req),
            } as never),
        ],
        catalog,
        outgoingInterceptors: outgoing.map((options) => createClientBearerInterceptor(options)),
        remoteResolver: singleTransportResolver(createGrpcTransport({ baseUrl: receiverUrl })),
        shutdown: { timeout: 200 },
    });
    callers.push(server);
    return server;
}

async function viaCtxCall(server: Server): Promise<string> {
    const caller = server.localClient(Caller) as unknown as { run(request: unknown): Promise<{ value: string }> };
    return (await caller.run(msg("hello"))).value;
}

describe("catalog calls to a JWKS-protected receiver over TCP", () => {
    it("ctx.call: the receiver sees the subject verified from the chain's bearer token, and the token factory runs once", async () => {
        let factoryCalls = 0;
        const token = await tokenFor(trustedKey, ISSUER, "svc-caller");
        const server = makeCaller([
            {
                token: async () => {
                    factoryCalls += 1;
                    return token;
                },
            },
        ]);
        assert.strictEqual(await viaCtxCall(server), "hello:svc-caller");
        assert.strictEqual(factoryCalls, 1);
    });

    it("server.client(): a server-stream reaches the handler with the verified token", async () => {
        const token = await tokenFor(trustedKey, ISSUER, "svc-caller");
        const server = makeCaller([{ token }]);
        const out: string[] = [];
        for await (const item of (server.client(Probe as never) as unknown as { count(r: unknown): AsyncIterable<{ value: string }> }).count(msg("s"))) out.push(item.value);
        assert.deepStrictEqual(out, ["s-0", "s-1"]);
    });

    it("without a chain the receiver rejects the call as Unauthenticated", async () => {
        const server = makeCaller([]);
        await assert.rejects(viaCtxCall(server), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });

    it("a token from an untrusted issuer, signed by a key the JWKS does not publish, is Unauthenticated", async () => {
        const server = makeCaller([{ token: await tokenFor(foreignKey, "https://issuer.untrusted.example", "svc-intruder") }]);
        await assert.rejects(viaCtxCall(server), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });
});

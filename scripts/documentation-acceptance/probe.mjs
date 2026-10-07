import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const mode = process.argv[2];
const auth = mode === "readme-auth";
const quickstart = mode.startsWith("quickstart");
const http1 = mode === "quickstart-http1";
const execute = promisify(execFile);
const buf = fileURLToPath(new URL("./node_modules/.bin/buf", import.meta.url));
let jwks;
let server;
let authorization;

try {
    if (auth) {
        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const key = { ...(await exportJWK(publicKey)), kid: "documentation-acceptance", alg: "RS256", use: "sig" };
        jwks = createHttpServer((_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ keys: [key] }));
        });
        await new Promise((resolve, reject) => {
            jwks.once("error", reject);
            jwks.listen(0, "127.0.0.1", resolve);
        });
        process.env.JWKS_URI = `http://127.0.0.1:${jwks.address().port}/jwks`;
        const issuer = "https://documentation-acceptance.invalid";
        process.env.JWT_ISSUER = issuer;
        authorization = `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: key.kid }).setSubject("reader").setIssuer(issuer).setAudience("my-api").setIssuedAt().setExpirationTime("2m").sign(privateKey)}`;
    }
    process.env.OTEL_TRACES_EXPORTER = "none";
    process.env.OTEL_METRICS_EXPORTER = "none";
    process.env.OTEL_LOGS_EXPORTER = "none";
    if (quickstart) server = (await import("./src/index.ts")).server;
    else {
        server = (await import("./src/server.ts")).buildServer(0, false);
        await server.start();
        healthcheckManager.update(ServingStatus.SERVING);
    }
    const baseUrl = `http://127.0.0.1:${server.address.port}`;
    if (http1) {
        const call = (name) =>
            fetch(`${baseUrl}/greeter.v1.GreeterService/SayHello`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name }),
            });
        const response = await call("Reader");
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { message: "Hello, Reader!" });
        const invalid = await call("");
        assert.equal(invalid.status, 400);
        const error = await invalid.json();
        assert.equal(error.code, "invalid_argument");
        assert.ok(error.message.includes("name"));
        const health = await fetch(`${baseUrl}/healthz`);
        assert.equal(health.status, 200);
        const body = await health.json();
        assert.deepEqual(Object.keys(body).sort(), ["service", "status", "timestamp"]);
        assert.equal(body.status, "SERVING");
        assert.equal(body.service, "overall");
        assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    } else {
        const { GreeterService } = await import(quickstart ? "./gen/greeter_pb.ts" : "./gen/greeter/v1/greeter_pb.ts");
        const client = createClient(GreeterService, createGrpcTransport({ baseUrl }));
        const options = authorization ? { headers: { authorization } } : undefined;
        if (auth) await assert.rejects(client.sayHello({ name: "Reader" }), (error) => error.code === Code.Unauthenticated);
        const response = await client.sayHello({ name: "Reader" }, options);
        assert.equal(response.message, "Hello, Reader!");
        if (quickstart) await assert.rejects(client.sayHello({ name: "" }, options), (error) => error.code === Code.InvalidArgument);
        else assert.equal((await client.sayHello({ name: "" }, options)).message, "Hello, world!");
        // No schema argument: buf must discover Health through server reflection.
        const args = ["curl", "--protocol", "grpc", "--http2-prior-knowledge", "--data", "{}"];
        if (authorization) args.push("--header", `Authorization: ${authorization}`, "--reflect-header", "*");
        args.push(`${baseUrl}/grpc.health.v1.Health/Check`);
        if (mode === "readme-core") {
            // The core-only example deliberately does not register health/reflection.
            await assert.rejects(execute(buf, args, { timeout: 15_000 }), (error) => {
                assert.match(error.stderr, /unimplemented|does not support.*reflection|server reflection.*not|failed to find service named "grpc\.health\.v1\.Health" in schema/i);
                return true;
            });
        } else {
            const { stdout } = await execute(buf, args, { timeout: 15_000 });
            assert.deepEqual(JSON.parse(stdout), { status: "SERVING" });
        }
    }
    await server.stop();
    await assert.rejects(fetch(`${baseUrl}/healthz`));
    console.log(`documentation-acceptance: ${mode} passed RPC response and empty-input expectations, configured protocols and listener cleanup`);
} finally {
    try {
        if (server?.isRunning) await server.stop();
    } finally {
        if (jwks) await new Promise((resolve, reject) => jwks.close((error) => (error ? reject(error) : resolve())));
    }
}

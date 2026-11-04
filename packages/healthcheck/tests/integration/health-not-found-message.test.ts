/**
 * The NOT_FOUND answer of Health.Check must stay small however long the
 * requested service name is.
 *
 * The message used to embed the whole name. A name past the HTTP/2 frame limit
 * (about 70000 characters) made the response itself too large: the stream
 * failed with a frame-size error and the session could not be used for the next
 * call. Everything here goes through a real gRPC client over HTTP/2.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("Health.Check NOT_FOUND message", () => {
    let server: Server;
    let client: ReturnType<typeof createClient<typeof Health>>;

    before(async () => {
        const manager = createHealthcheckManager();
        manager.set("db", ServingStatus.SERVING);
        server = createServer({ services: [], port: 0, protocols: [Healthcheck({ manager })], allowHTTP1: false });
        await server.start();
        client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
    });

    after(async () => {
        await server?.stop();
    });

    async function notFound(service: string): Promise<ConnectError> {
        try {
            await client.check({ service });
        } catch (err) {
            return ConnectError.from(err);
        }
        return assert.fail(`Check for a ${service.length}-character name must fail with NOT_FOUND`);
    }

    it("echoes a short name in full", async () => {
        const err = await notFound("missing.v1.Service");

        assert.strictEqual(err.code, Code.NotFound);
        assert.strictEqual(err.rawMessage, "Service 'missing.v1.Service' not found");
    });

    it("echoes a name of exactly 128 characters unchanged", async () => {
        const name = "a".repeat(128);

        const err = await notFound(name);

        assert.strictEqual(err.code, Code.NotFound);
        assert.strictEqual(err.rawMessage, `Service '${name}' not found`);
    });

    it("cuts a name of 129 characters to 128 and marks the cut", async () => {
        const err = await notFound("a".repeat(129));

        assert.strictEqual(err.code, Code.NotFound);
        assert.strictEqual(err.rawMessage, `Service '${"a".repeat(128)}…' not found`);
    });

    it("answers NOT_FOUND with a short message for a 70000-character name and keeps the session usable", async () => {
        const err = await notFound("x".repeat(70_000));

        assert.strictEqual(err.code, Code.NotFound, `expected NOT_FOUND, got ${err.message}`);
        assert.ok(err.rawMessage.length < 200, `message must stay bounded, was ${err.rawMessage.length} characters`);

        // The call that follows reuses the same HTTP/2 session.
        assert.strictEqual((await client.check({ service: "db" })).status, ServingStatus.SERVING);
    });

    it("answers NOT_FOUND for a 1,000,000-character name", async () => {
        const err = await notFound("x".repeat(1_000_000));

        assert.strictEqual(err.code, Code.NotFound, `expected NOT_FOUND, got ${err.message}`);
        assert.ok(err.rawMessage.length < 200);
        assert.strictEqual((await client.check({ service: "db" })).status, ServingStatus.SERVING);
    });

    it("does not split a surrogate pair when it cuts", async () => {
        // 127 ASCII characters, then an emoji (two UTF-16 code units) that
        // straddles the 128-code-unit mark.
        const err = await notFound(`${"a".repeat(127)}😀tail`);

        assert.strictEqual(err.code, Code.NotFound);
        assert.strictEqual(err.rawMessage, `Service '${"a".repeat(127)}…' not found`);
    });
});

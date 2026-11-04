/**
 * A status the manager refuses must never reach a client.
 *
 * `set("db", "SERVING")` used to be stored, and the next Health.List (for every
 * service) and Health.Check of that component failed with an internal
 * serialization error that leaked the serializer text. Now the call that passes
 * the bad value throws and the registry keeps its previous state, so the wire
 * answers stay intact. Assertions go through a real gRPC client.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("Health answers after the manager refused a status", () => {
    let server: Server;
    let client: ReturnType<typeof createClient<typeof Health>>;
    const manager = createHealthcheckManager();

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Healthcheck({ manager })], allowHTTP1: false });
        await server.start();
        client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
        manager.set("db", ServingStatus.SERVING);
        manager.set("cache", ServingStatus.NOT_SERVING);
    });

    after(async () => {
        await server?.stop();
    });

    const badStatuses: Array<[string, unknown, ErrorConstructor]> = [
        ["a string name", "SERVING", TypeError],
        ["a numeric string", "1", TypeError],
        ["an out-of-range number", 99, RangeError],
        ["a fraction", 1.5, RangeError],
        ["a number past int32", 4_294_967_296, RangeError],
        ["a boolean", true, TypeError],
        ["null", null, TypeError],
        ["undefined", undefined, TypeError],
    ];

    for (const [label, value, expected] of badStatuses) {
        it(`keeps List and Check intact when set() gets ${label}`, async () => {
            assert.throws(
                () => manager.set("db", value as ServingStatus),
                (err: unknown) => err instanceof expected && err.constructor === expected,
            );

            const listed = await client.list({});
            assert.deepStrictEqual(
                Object.fromEntries(Object.entries(listed.statuses).map(([name, entry]) => [name, entry.status])),
                { db: ServingStatus.SERVING, cache: ServingStatus.NOT_SERVING },
            );
            assert.strictEqual((await client.check({ service: "db" })).status, ServingStatus.SERVING);
        });
    }

    it("keeps the statuses of update() intact for a refused value", async () => {
        assert.throws(() => manager.update(99 as ServingStatus));
        assert.throws(() => manager.update("1" as unknown as ServingStatus, "db"));

        assert.strictEqual((await client.check({ service: "" })).status, ServingStatus.NOT_SERVING);
        assert.strictEqual((await client.check({ service: "db" })).status, ServingStatus.SERVING);
    });

    it("still accepts every ServingStatus value", async () => {
        for (const status of [ServingStatus.UNKNOWN, ServingStatus.SERVING, ServingStatus.NOT_SERVING]) {
            manager.set("db", status);
            assert.strictEqual((await client.check({ service: "db" })).status, status);
        }
    });
});

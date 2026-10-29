/**
 * A valid watchInterval keeps Health.Watch polling at that cadence, and a
 * refused one never gets as far as a server.
 *
 * With 0, a negative number or NaN the platform turns the timer delay into
 * 1 ms, so every open Watch read the manager about a thousand times a second.
 * The count below is taken at the manager (one read per tick) while a real
 * gRPC client holds a Watch open.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { HealthcheckManager } from "../../src/HealthcheckManager.ts";

class CountingManager extends HealthcheckManager {
    reads = 0;
    override areAllHealthy(): boolean {
        this.reads++;
        return super.areAllHealthy();
    }
}

describe("Health.Watch polling cadence", () => {
    let server: Server;
    let client: ReturnType<typeof createClient<typeof Health>>;
    const manager = new CountingManager();

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Healthcheck({ manager, watchInterval: 200 })], allowHTTP1: false });
        await server.start();
        client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
    });

    after(async () => {
        await server?.stop();
    });

    it("re-reads the manager about every 200 ms while a Watch is open, not every millisecond", async () => {
        const controller = new AbortController();
        const stream = client.watch({ service: "" }, { signal: controller.signal })[Symbol.asyncIterator]();
        await stream.next();
        const start = manager.reads;

        await delay(1000);
        const reads = manager.reads - start;
        controller.abort();

        // Five ticks are expected; a flood would be hundreds.
        assert.ok(reads >= 3 && reads <= 10, `expected about 5 reads in one second at a 200 ms interval, got ${reads}`);
    });

    it("never builds a server from a refused watchInterval", () => {
        for (const watchInterval of [0, -5, Number.NaN, "abc", null]) {
            assert.throws(() => createServer({ services: [], port: 0, protocols: [Healthcheck({ watchInterval: watchInterval as number })] }), /watchInterval/);
        }
    });
});

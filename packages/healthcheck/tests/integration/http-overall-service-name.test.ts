/**
 * `/healthz?service=` is documented to behave exactly like `/healthz`:
 * same status, same HTTP code, and the body names the scope as "overall".
 * The body used to carry an empty string instead. Real HTTP requests against a
 * running server.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("HTTP health body for the overall scope", () => {
    let server: Server;
    let base: string;
    const manager = createHealthcheckManager();

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Healthcheck({ httpEnabled: true, manager })] });
        await server.start();
        base = `http://127.0.0.1:${server.address?.port}`;
    });

    after(async () => {
        await server?.stop();
    });

    async function probe(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
        const res = await fetch(`${base}${path}`);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    for (const [label, state, status, name] of [
        ["serving", ServingStatus.SERVING, 200, "SERVING"],
        ["not serving", ServingStatus.NOT_SERVING, 503, "NOT_SERVING"],
    ] as const) {
        it(`reports "overall" for an empty service value when the process is ${label}`, async () => {
            manager.set("process", state);

            const bare = await probe("/healthz");
            const empty = await probe("/healthz?service=");

            assert.strictEqual(bare.status, status);
            assert.strictEqual(bare.body.service, "overall");
            assert.strictEqual(empty.status, status);
            assert.strictEqual(empty.body.status, name);
            assert.strictEqual(empty.body.service, "overall");
        });
    }

    it("still names a requested service and an unknown one", async () => {
        manager.set("process", ServingStatus.SERVING);

        const known = await probe("/healthz?service=process");
        const unknown = await probe("/healthz?service=missing.v1.Service");

        assert.deepStrictEqual([known.status, known.body.service, known.body.status], [200, "process", "SERVING"]);
        assert.deepStrictEqual([unknown.status, unknown.body.service, unknown.body.status], [404, "missing.v1.Service", "SERVICE_UNKNOWN"]);
    });
});

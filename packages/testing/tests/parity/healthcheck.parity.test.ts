/**
 * Group 9 — gRPC Health Checking parity.
 *
 *   9.1 Check: a known component, and a service name far longer than an HTTP/2 frame
 *   9.2 Watch: a status that goes down and up at once reaches the client as two changes
 *
 * Health is a protocol registered by `@connectum/healthcheck`, not a user
 * service. Each scenario asserts the answer the Health protocol fixes (the
 * documented `NOT_FOUND` for an unknown service with a bounded message; every
 * change delivered, in order) on both transports before comparing them, so two
 * transports that agree on a wrong answer still fail.
 */

import assert from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createHealthcheckManager, Healthcheck, ServingStatus } from "@connectum/healthcheck";
import { Health } from "../../../healthcheck/gen/grpc/health/v1/health_pb.js";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";

// One manager for both runs of a scenario: the runs are sequential and each
// starts by putting the component into the state it needs.
const manager = createHealthcheckManager();
const protocol = Healthcheck({ manager, watchInterval: 60_000 });

// 9.1
transportParityTest("parity 9.1: Check answers NOT_FOUND with a bounded message for a huge service name", {
    services: [],
    protocols: [protocol],
    scenario: async ({ transport }) => {
        const client = createClient(Health, transport);
        manager.set("db", ServingStatus.SERVING);
        const known = await client.check({ service: "db" });
        try {
            await client.check({ service: "x".repeat(70_000) });
        } catch (err) {
            const error = ConnectError.from(err);
            return { response: { knownStatus: known.status }, error: { code: error.code, message: error.rawMessage } };
        }
        throw new Error("Check for an unknown service must fail");
    },
    compare: (http: ParityScenarioResult, local: ParityScenarioResult) => {
        const expected = { code: Code.NotFound, message: `Service '${"x".repeat(128)}…' not found` };
        assert.deepStrictEqual(http.error, expected, "HTTP transport error");
        assert.deepStrictEqual(local.error, expected, "Local transport error");
        assert.deepStrictEqual(http.response, { knownStatus: ServingStatus.SERVING });
        defaultCompare(http, local);
    },
});

// 9.2
transportParityTest("parity 9.2: Watch delivers both changes of a status that goes down and up at once", {
    services: [],
    protocols: [protocol],
    scenario: async ({ transport }) => {
        const client = createClient(Health, transport);
        manager.set("db", ServingStatus.SERVING);
        const controller = new AbortController();
        const received: ServingStatus[] = [];
        const stream = client.watch({ service: "db" }, { signal: controller.signal })[Symbol.asyncIterator]();
        // A server that loses a change would leave the stream silent; fail with a reason instead of hanging.
        const next = async () => {
            const guard = new AbortController();
            try {
                return await Promise.race([
                    stream.next(),
                    delay(5000, undefined, { signal: guard.signal }).then(() => {
                        throw new Error(`no Watch message within 5 s, received ${JSON.stringify(received)}`);
                    }),
                ]);
            } finally {
                guard.abort();
            }
        };
        try {
            received.push((await next()).value.status);
            // Same tick: the interval is a minute, so only notifications can deliver these.
            manager.set("db", ServingStatus.NOT_SERVING);
            manager.set("db", ServingStatus.SERVING);
            received.push((await next()).value.status);
            received.push((await next()).value.status);
        } finally {
            controller.abort();
        }
        return { response: { statuses: received } };
    },
    compare: (http: ParityScenarioResult, local: ParityScenarioResult) => {
        const expected = { statuses: [ServingStatus.SERVING, ServingStatus.NOT_SERVING, ServingStatus.SERVING] };
        assert.deepStrictEqual(http.response, expected, "HTTP transport result");
        assert.deepStrictEqual(local.response, expected, "Local transport result");
        defaultCompare(http, local);
    },
});

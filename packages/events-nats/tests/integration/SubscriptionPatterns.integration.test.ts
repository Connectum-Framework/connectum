/**
 * A subscription pattern with an empty segment is refused before the adapter creates anything on the
 * broker, even when the call also lists a good pattern: no consumer is left for either of them, for
 * a named group as well as for an auto-generated one.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;
const SCENARIO_TIMEOUT_MS = 60_000;

function uniqueName(prefix: string): string {
    return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

describe("NATS adapter: subscription patterns with empty segments", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    async function consumerNames(stream: string): Promise<string[]> {
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            const names: string[] = [];
            for await (const info of manager.consumers.list(stream)) {
                names.push(info.name);
            }
            return names.sort();
        } finally {
            await connection.close();
        }
    }

    for (const [label, pattern] of [
        ["the empty string", ""],
        ["an empty segment between dots", "a..b"],
        ["a leading dot", ".a"],
        ["a trailing dot", "a."],
        ["a lone dot", "."],
    ] as const) {
        it(`rejects ${label} and creates no consumer for a named group or an auto-generated one`, { timeout: SCENARIO_TIMEOUT_MS }, async () => {
            const stream = uniqueName("emp");
            const adapter = NatsAdapter({ servers, stream });
            await adapter.connect();
            try {
                const rejected = (error: unknown) => error instanceof TypeError && error.message.startsWith(`NatsAdapter: subscription pattern "${pattern}" has an empty segment (`);

                await assert.rejects(adapter.subscribe(["ok.one", pattern], async () => undefined, { group: uniqueName("grp") }), rejected);
                await assert.rejects(adapter.subscribe(["ok.one", pattern], async () => undefined), rejected);

                assert.deepEqual(await consumerNames(stream), [], "the good pattern of a rejected call got no consumer either");
            } finally {
                await adapter.disconnect();
            }
        });
    }

    it("still subscribes literal, single-segment wildcard and tail wildcard patterns", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("emp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            const subscription = await adapter.subscribe(["ok.one", "ok.*", "ok.>"], async () => undefined, { group: uniqueName("grp") });
            assert.equal((await consumerNames(stream)).length, 3);
            await subscription.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });
});

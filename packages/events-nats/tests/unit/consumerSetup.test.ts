import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumerConfig, ConsumerInfo, JetStreamManager } from "@nats-io/jetstream";
import { ensureConsumer } from "../../src/consumerSetup.ts";

const SECOND_NS = 1_000_000_000;

/** A manager that reports one existing consumer and refuses every write: the adapter must only read. */
function managerWith(existing: Pick<ConsumerConfig, "ack_wait" | "max_deliver" | "deliver_policy">): { jsm: JetStreamManager; writes: string[] } {
    const writes: string[] = [];
    const info = {
        config: existing,
        ack_floor: { stream_seq: 7 },
        delivered: { stream_seq: 9 },
    } as unknown as ConsumerInfo;
    const jsm = {
        consumers: {
            info: async () => info,
            add: async () => {
                writes.push("add");
                throw new Error("an existing consumer must not be created again");
            },
            update: async () => {
                writes.push("update");
                throw new Error("an existing consumer must not be updated");
            },
        },
    } as unknown as JetStreamManager;
    return { jsm, writes };
}

async function warningsOf(run: () => Promise<unknown>): Promise<string[]> {
    const original = console.warn;
    const logged: string[] = [];
    console.warn = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
    };
    try {
        await run();
    } finally {
        console.warn = original;
    }
    return logged;
}

describe("ensureConsumer: existing consumer", () => {
    const requested = { ack_wait: 30 * SECOND_NS, max_deliver: 5, deliver_policy: "new" } as const;

    it("returns the acknowledgement floor plus one and writes nothing", async () => {
        const { jsm, writes } = managerWith(requested);
        const logged = await warningsOf(async () => {
            assert.equal(await ensureConsumer(jsm, "s-same", { durable_name: "same", ...requested } as never), 8);
        });
        assert.deepEqual(writes, []);
        assert.deepEqual(logged, [], "an equal configuration is silent");
    });

    it("warns once per consumer when ack_wait, max_deliver or deliver_policy differ, and keeps the existing configuration", async () => {
        const { jsm, writes } = managerWith({ ack_wait: 10 * SECOND_NS, max_deliver: 3, deliver_policy: "all" });
        const first = await warningsOf(async () => {
            assert.equal(await ensureConsumer(jsm, "s-drift", { durable_name: "drift", ...requested } as never), 8);
        });
        assert.deepEqual(writes, []);
        assert.equal(first.length, 1);
        const line = first[0] as string;
        assert.match(line, /"drift"/);
        assert.match(line, /ack_wait/);
        assert.match(line, /max_deliver/);
        assert.match(line, /deliver_policy/);
        assert.match(line, /existing configuration is kept/);

        const second = await warningsOf(async () => {
            await ensureConsumer(jsm, "s-drift", { durable_name: "drift", ...requested } as never);
        });
        assert.deepEqual(second, [], "the same consumer is reported once per process");
    });

    it("names only the fields that differ", async () => {
        const { jsm } = managerWith({ ...requested, ack_wait: 10 * SECOND_NS });
        const logged = await warningsOf(async () => {
            await ensureConsumer(jsm, "s-one", { durable_name: "one", ...requested } as never);
        });
        assert.equal(logged.length, 1);
        assert.match(logged[0] as string, /ack_wait/);
        assert.doesNotMatch(logged[0] as string, /max_deliver|deliver_policy/);
    });
});

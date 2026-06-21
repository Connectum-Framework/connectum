/**
 * Tests for the broadcast / fan-out helper (`createBroadcastSubscribers`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createBroadcastSubscribers } from "../../src/broadcast.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import type { EventRoute } from "../../src/types.ts";

// Minimal fake DescMethod/DescService (mirrors per-handler-middleware.test.ts):
// a real schema (EventOptionsSchema) is used as the event message so the bus can
// decode an empty payload; the topic falls back to its typeName.
// biome-ignore lint/suspicious/noExplicitAny: minimal proto desc fake for tests
function fakeDescMethod(localName: string, typeName: string, realInput: any) {
    const input = Object.create(realInput, { typeName: { value: typeName, writable: false, enumerable: true } });
    return { localName, input, proto: { options: undefined } };
}

// biome-ignore lint/suspicious/noExplicitAny: minimal proto desc fake for tests
function fakeDescService(typeName: string, methods: any[]) {
    return { typeName, methods };
}

describe("createBroadcastSubscribers", () => {
    it("throws when two reactors share a consumer group", () => {
        assert.throws(
            () =>
                createBroadcastSubscribers({
                    adapter: MemoryAdapter(),
                    reactors: [
                        { group: "shared", routes: [] },
                        { group: "shared", routes: [] },
                    ],
                }),
            /distinct group/i,
        );
    });

    it("builds one independent, startable bus per reactor", () => {
        const buses = createBroadcastSubscribers({
            adapter: MemoryAdapter(),
            reactors: [
                { group: "a", routes: [] },
                { group: "b", routes: [] },
                { group: "c", routes: [] },
            ],
        });
        assert.equal(buses.length, 3);
        for (const bus of buses) {
            assert.equal(typeof bus.start, "function");
            assert.equal(typeof bus.stop, "function");
        }
    });

    it("invokes the adapter factory once per reactor (own connection per bus)", () => {
        let built = 0;
        createBroadcastSubscribers({
            adapter: () => {
                built++;
                return MemoryAdapter();
            },
            reactors: [
                { group: "a", routes: [] },
                { group: "b", routes: [] },
            ],
        });
        assert.equal(built, 2);
    });

    it("fans one published event out to EVERY reactor (shared adapter)", async () => {
        const topic = EventOptionsSchema.typeName;
        const method = fakeDescMethod("onEvent", topic, EventOptionsSchema);
        const service = fakeDescService("test.v1.BroadcastService", [method]);

        const fired: string[] = [];
        const reactorRoute =
            (name: string): EventRoute =>
            (router) => {
                router.service(
                    // biome-ignore lint/suspicious/noExplicitAny: fake service desc
                    service as any,
                    {
                        onEvent: async () => {
                            fired.push(name);
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: fake handler map
                    } as any,
                );
            };

        const adapter = MemoryAdapter();
        const buses = createBroadcastSubscribers({
            adapter,
            reactors: [
                { group: "pricing", routes: [reactorRoute("pricing")] },
                { group: "audit", routes: [reactorRoute("audit")] },
                { group: "notify", routes: [reactorRoute("notify")] },
            ],
        });

        try {
            await Promise.all(buses.map((bus) => bus.start()));
            await adapter.publish(topic, new Uint8Array());
            assert.deepEqual([...fired].sort(), ["audit", "notify", "pricing"]);
        } finally {
            await Promise.all(buses.map((bus) => bus.stop()));
        }
    });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import { assertSubscriptionPatterns } from "../../src/subscriptionPatterns.ts";

/** A rejection is a TypeError whose message names the adapter, the offending pattern, where the empty segment is, and the rule. */
function rejection(adapter: string, pattern: string, reason: string): (error: unknown) => boolean {
    const message = `${adapter}: subscription pattern "${pattern}" has an empty segment (${reason}). Every dot-separated segment of a pattern must be non-empty.`;
    return (error) => error instanceof TypeError && error.message === message;
}

describe("assertSubscriptionPatterns", () => {
    it("rejects the empty string", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [""] }), rejection("TestAdapter", "", "the pattern is empty"));
    });

    it("rejects an empty segment between two dots", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a..b"] }), rejection("TestAdapter", "a..b", 'it contains ".."'));
    });

    it("rejects a leading dot", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [".a"] }), rejection("TestAdapter", ".a", 'it starts with "."'));
    });

    it("rejects a trailing dot", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a."] }), rejection("TestAdapter", "a.", 'it ends with "."'));
    });

    it("rejects a lone dot", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["."] }), rejection("TestAdapter", ".", 'it starts with "."'));
    });

    it("rejects an empty segment next to a wildcard", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a.*."] }), rejection("TestAdapter", "a.*.", 'it ends with "."'));
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["*..>"] }), rejection("TestAdapter", "*..>", 'it contains ".."'));
    });

    it("names the first bad pattern of a list in a TypeError", () => {
        assert.throws(
            () => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["ok.one", "bad..two", "."] }),
            rejection("TestAdapter", "bad..two", 'it contains ".."'),
        );
    });

    it("accepts literal patterns and both wildcards", () => {
        for (const pattern of ["a", "a.b", "a.b.c", "a.*", "a.>", ">", "*", "*.b", "a.*.c", "a_b.c-d"]) {
            assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [pattern] }), pattern);
        }
    });

    it("accepts a list of good patterns and an empty list", () => {
        assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a.b", "a.*", "a.>", ">"] }));
        assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [] }));
    });
});

describe("MemoryAdapter subscription patterns", () => {
    for (const [label, pattern, reason] of [
        ["the empty string", "", "the pattern is empty"],
        ["an empty segment between dots", "a..b", 'it contains ".."'],
        ["a leading dot", ".a", 'it starts with "."'],
        ["a trailing dot", "a.", 'it ends with "."'],
        ["a lone dot", ".", 'it starts with "."'],
    ] as const) {
        it(`rejects ${label} and registers no subscription`, async () => {
            const adapter = MemoryAdapter();
            await adapter.connect();
            const received: string[] = [];

            await assert.rejects(
                adapter.subscribe(["a.b", pattern], async (event) => {
                    received.push(event.eventType);
                }),
                rejection("MemoryAdapter", pattern, reason),
            );

            await adapter.publish("a.b", new Uint8Array([1]));
            assert.deepEqual(received, [], "the rejected call left no subscription behind, not even for its good pattern");
            await adapter.disconnect();
        });
    }

    it("accepts literal, single-segment wildcard and tail wildcard patterns", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const received: string[] = [];

        await adapter.subscribe(["a.b", "c.*", "d.>", ">"], async (event) => {
            received.push(event.eventType);
        });
        await adapter.publish("a.b", new Uint8Array([1]));

        assert.ok(received.includes("a.b"));
        await adapter.disconnect();
    });
});

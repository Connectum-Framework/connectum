/**
 * `NatsAdapter()` refuses options it cannot honor when it is created, and names the option.
 *
 * Before, each of these was accepted and either replaced silently (`ackWait: 0` became the 30 s
 * default, `deliverPolicy: "bogus"` behaved like "new", `servers: []` dialled the local default
 * address) or misbehaved at run time (`ackWait: -1` redelivered at once, a fractional `maxDeliver`
 * was refused by the server only when the first subscription started).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

/** Build an adapter from options the type system would not let a TypeScript caller write. */
function create(options: unknown): unknown {
    return NatsAdapter(options as Parameters<typeof NatsAdapter>[0]);
}

const SERVERS = "nats://localhost:4222";

const wrongType: ReadonlyArray<[label: string, options: unknown, message: RegExp]> = [
    ["no options", undefined, /^NatsAdapter: options must be an object with servers, got undefined$/],
    ["null options", null, /^NatsAdapter: options must be an object with servers, got null$/],
    ["an array as options", [], /^NatsAdapter: options must be an object with servers, got an array$/],
    ["no servers", {}, /^NatsAdapter: servers must be a non-empty string or a non-empty array of non-empty strings, got undefined$/],
    ["a number as servers", { servers: 4222 }, /servers must be a non-empty string or a non-empty array of non-empty strings, got 4222$/],
    ["a non-string entry in servers", { servers: [SERVERS, 4222] }, /^NatsAdapter: servers\[1\] must be a non-empty string, got 4222$/],
    ["a string as consumerOptions", { servers: SERVERS, consumerOptions: "fast" }, /^NatsAdapter: consumerOptions must be an object, got "fast"$/],
    ["a string as ackWait", { servers: SERVERS, consumerOptions: { ackWait: "30000" } }, /^NatsAdapter: consumerOptions\.ackWait must be .*, got "30000"$/],
    ["a string as maxDeliver", { servers: SERVERS, consumerOptions: { maxDeliver: "5" } }, /^NatsAdapter: consumerOptions\.maxDeliver must be -1 \(unlimited\) or a positive integer, got "5"$/],
    ["an unknown deliverPolicy", { servers: SERVERS, consumerOptions: { deliverPolicy: "bogus" } }, /^NatsAdapter: consumerOptions\.deliverPolicy must be one of "new", "all", "last", got "bogus"$/],
    ["a deliverPolicy of another case", { servers: SERVERS, consumerOptions: { deliverPolicy: "ALL" } }, /^NatsAdapter: consumerOptions\.deliverPolicy must be one of "new", "all", "last", got "ALL"$/],
    ["a number as deliverPolicy", { servers: SERVERS, consumerOptions: { deliverPolicy: 1 } }, /deliverPolicy must be one of .*, got 1$/],
];

const outOfRange: ReadonlyArray<[label: string, options: unknown, message: RegExp]> = [
    ["an empty servers string", { servers: "" }, /^NatsAdapter: servers must be a non-empty string or a non-empty array of non-empty strings, got ""$/],
    ["a blank servers string", { servers: "   " }, /servers must be a non-empty string/],
    ["an empty servers array", { servers: [] }, /^NatsAdapter: servers must be a non-empty string or a non-empty array of non-empty strings, got an array$/],
    ["an empty entry in servers", { servers: [SERVERS, ""] }, /^NatsAdapter: servers\[1\] must be a non-empty string, got ""$/],
    ["ackWait 0", { servers: SERVERS, consumerOptions: { ackWait: 0 } }, /^NatsAdapter: consumerOptions\.ackWait must be a finite number of milliseconds greater than 0 and at most \d+, got 0$/],
    ["a negative ackWait", { servers: SERVERS, consumerOptions: { ackWait: -1 } }, /consumerOptions\.ackWait must be .*, got -1$/],
    ["a NaN ackWait", { servers: SERVERS, consumerOptions: { ackWait: Number.NaN } }, /consumerOptions\.ackWait must be .*, got NaN$/],
    ["an infinite ackWait", { servers: SERVERS, consumerOptions: { ackWait: Number.POSITIVE_INFINITY } }, /consumerOptions\.ackWait must be .*, got Infinity$/],
    ["an ackWait that does not fit nanoseconds", { servers: SERVERS, consumerOptions: { ackWait: 1e13 } }, /consumerOptions\.ackWait must be .*, got 10000000000000$/],
    ["an ackWait below one nanosecond", { servers: SERVERS, consumerOptions: { ackWait: 1e-7 } }, /consumerOptions\.ackWait must be .*, got 1e-7$/],
    ["maxDeliver 0", { servers: SERVERS, consumerOptions: { maxDeliver: 0 } }, /^NatsAdapter: consumerOptions\.maxDeliver must be -1 \(unlimited\) or a positive integer, got 0$/],
    ["maxDeliver -2", { servers: SERVERS, consumerOptions: { maxDeliver: -2 } }, /maxDeliver must be -1 \(unlimited\) or a positive integer, got -2$/],
    ["a fractional maxDeliver", { servers: SERVERS, consumerOptions: { maxDeliver: 1.5 } }, /maxDeliver must be -1 \(unlimited\) or a positive integer, got 1\.5$/],
    ["a NaN maxDeliver", { servers: SERVERS, consumerOptions: { maxDeliver: Number.NaN } }, /maxDeliver must be .*, got NaN$/],
    ["an infinite maxDeliver", { servers: SERVERS, consumerOptions: { maxDeliver: Number.POSITIVE_INFINITY } }, /maxDeliver must be .*, got Infinity$/],
];

describe("NatsAdapter option validation", () => {
    for (const [label, options, message] of wrongType) {
        it(`throws a TypeError for ${label}`, () => {
            assert.throws(
                () => create(options),
                (error: unknown) => error instanceof TypeError && message.test(error.message),
            );
        });
    }

    for (const [label, options, message] of outOfRange) {
        it(`throws a RangeError for ${label}`, () => {
            assert.throws(
                () => create(options),
                (error: unknown) => error instanceof RangeError && message.test(error.message),
            );
        });
    }

    it("accepts every value that was valid before and does not change it", () => {
        const accepted: unknown[] = [
            { servers: SERVERS },
            { servers: [SERVERS] },
            { servers: [SERVERS, "nats://other:4222"], stream: "orders", connectionOptions: { timeout: 1000 } },
            { servers: SERVERS, consumerOptions: {} },
            { servers: SERVERS, consumerOptions: { deliverPolicy: "new" } },
            { servers: SERVERS, consumerOptions: { deliverPolicy: "all" } },
            { servers: SERVERS, consumerOptions: { deliverPolicy: "last" } },
            { servers: SERVERS, consumerOptions: { ackWait: 1 } },
            { servers: SERVERS, consumerOptions: { ackWait: 1500.5 } },
            { servers: SERVERS, consumerOptions: { ackWait: 86_400_000 } },
            { servers: SERVERS, consumerOptions: { maxDeliver: -1 } },
            { servers: SERVERS, consumerOptions: { maxDeliver: 1 } },
            { servers: SERVERS, consumerOptions: { maxDeliver: 5 } },
            { servers: SERVERS, consumerOptions: { ackWait: 30_000, maxDeliver: 10, deliverPolicy: "all" } },
            { servers: SERVERS, consumerOptions: { ackWait: undefined, maxDeliver: undefined, deliverPolicy: undefined } },
        ];
        for (const options of accepted) {
            const adapter = create(options) as { name: string };
            assert.equal(adapter.name, "nats");
        }
    });
});

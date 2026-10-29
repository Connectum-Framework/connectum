/**
 * Options the adapter cannot honor are rejected when it is created, with an
 * error that names the option. Nothing here needs a broker: the factory must
 * refuse before any connection is attempted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AmqpAdapterOptions } from "../../src/index.ts";
import { AmqpAdapter, AmqpTopologyMode } from "../../src/index.ts";

const URL = "amqp://127.0.0.1:1";

/** Build the options without the compiler's help: the point is the runtime check for JavaScript callers. */
function create(extra: Record<string, unknown>): void {
    AmqpAdapter({ url: URL, ...extra } as AmqpAdapterOptions);
}

describe("topologyMode", () => {
    it("accepts exactly the three documented modes, and an unset option", () => {
        for (const mode of Object.values(AmqpTopologyMode)) {
            assert.doesNotThrow(() => create({ topologyMode: mode }), mode);
        }
        assert.doesNotThrow(() => create({}));
        assert.doesNotThrow(() => create({ topologyMode: undefined }));
    });

    for (const bad of ["CHECK", "Check", "SKIP", "Assert", "bogus", "", 42, null, true, {}, ["check"]]) {
        it(`rejects ${JSON.stringify(bad)} instead of acting as assert, naming the option and the allowed values`, () => {
            assert.throws(
                () => create({ topologyMode: bad }),
                (error: unknown) => {
                    assert.ok(error instanceof TypeError, `expected TypeError, got ${String(error)}`);
                    assert.match(error.message, /topologyMode/);
                    assert.match(error.message, /"assert", "check", "skip"/);
                    return true;
                },
            );
        });
    }
});

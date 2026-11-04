/**
 * `createServer({ propagateHeaders })` is checked when the server is created.
 *
 * A malformed name used to be accepted and then threw a `TypeError` from
 * `Headers.get` on every `ctx.call`, which a handler that does not catch it
 * turns into `internal` for its caller.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { defaultPropagateHeaders } from "../../src/propagateHeaders.ts";
import { createServer } from "../../src/Server.ts";

describe("createServer propagateHeaders validation", () => {
    for (const name of ["x y", "", ":authority", "x\ty", "x:y", "é", "a,b"]) {
        it(`rejects the header name ${JSON.stringify(name)} naming the option and the entry`, () => {
            assert.throws(
                () => createServer({ services: [], propagateHeaders: [name] }),
                (error: unknown) => {
                    assert.ok(error instanceof TypeError);
                    assert.match(error.message, /propagateHeaders/);
                    assert.ok(error.message.includes(JSON.stringify(name)), `message must quote the entry, got: ${error.message}`);
                    return true;
                },
            );
        });
    }

    it("rejects a value that is not an array, naming the option", () => {
        assert.throws(() => createServer({ services: [], propagateHeaders: "x-request-id" as unknown as string[] }), /propagateHeaders must be an array/);
    });

    it("rejects an entry that is not a string", () => {
        assert.throws(() => createServer({ services: [], propagateHeaders: [42 as unknown as string] }), /propagateHeaders entry 42/);
    });

    it("rejects the invalid entry in a list that also holds valid ones", () => {
        assert.throws(() => createServer({ services: [], propagateHeaders: ["x-request-id", "bad name"] }), /"bad name"/);
    });

    it("accepts valid names, the default list, an empty list and no option", () => {
        createServer({ services: [], propagateHeaders: ["x-request-id", "X-Tenant-Id", "traceparent", "x_custom.v1~2"] });
        createServer({ services: [], propagateHeaders: [...defaultPropagateHeaders, "x-tenant-id"] });
        createServer({ services: [], propagateHeaders: [] });
        createServer({ services: [] });
    });
});

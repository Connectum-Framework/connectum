/**
 * Wording of failed reflection requests. The errors under test are built the way Node and Connect
 * build them (an `AggregateError` of refused connections, `ERR_HTTP2_ERROR` underneath
 * `[internal] Protocol error`); the same shapes come out of real servers in the process tests
 * of `proto sync`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { CliError } from "../../src/utils/cliError.ts";
import { describeReflectionFailure } from "../../src/utils/reflectionFailure.ts";

const ADDRESS = "http://localhost:5000";

function errno(code: string, message: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

describe("describeReflectionFailure", () => {
    it("names the address and the operating-system code when nobody listens, looking into an AggregateError", () => {
        // Node tries ::1 and 127.0.0.1 for `localhost` and reports both in one AggregateError.
        const aggregate = Object.assign(new AggregateError([errno("ECONNREFUSED", "connect ECONNREFUSED ::1:5000"), errno("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5000")]), {
            code: "ECONNREFUSED",
        });
        const connectError = new ConnectError("", Code.Unavailable, undefined, undefined, aggregate);

        const out = describeReflectionFailure(ADDRESS, connectError);

        assert.ok(out instanceof CliError);
        assert.equal(out.message, "Cannot connect to http://localhost:5000: ECONNREFUSED. Check the address and that the server is running.");
        assert.equal(out.cause, connectError);
    });

    it("finds the code on a member of an AggregateError that has none of its own", () => {
        const aggregate = new AggregateError([errno("ENOTFOUND", "getaddrinfo ENOTFOUND nowhere.invalid")]);
        const out = describeReflectionFailure(ADDRESS, new ConnectError("", Code.Unavailable, undefined, undefined, aggregate));

        assert.ok(out instanceof CliError);
        assert.match(out.message, /^Cannot connect to http:\/\/localhost:5000: ENOTFOUND\./);
    });

    it("still names the address when the cause carries no code", () => {
        const out = describeReflectionFailure(ADDRESS, new ConnectError("", Code.Unavailable));

        assert.ok(out instanceof CliError);
        assert.match(out.message, /^Cannot connect to http:\/\/localhost:5000: the server is unavailable\./);
    });

    it("recognises a server that does not speak HTTP/2 and names the setting that selects it", () => {
        const cause = errno("ERR_HTTP2_ERROR", "Protocol error");
        const out = describeReflectionFailure(ADDRESS, new ConnectError("Protocol error", Code.Internal, undefined, undefined, cause));

        assert.ok(out instanceof CliError);
        assert.match(out.message, /^HTTP\/2 protocol error talking to http:\/\/localhost:5000 \(Protocol error\)\./);
        assert.ok(out.message.includes("HTTP/1.1") && out.message.includes("allowHTTP1: false"), out.message);
    });

    it("keeps the server's own words, with the address, for an error the server answered with", () => {
        const out = describeReflectionFailure(ADDRESS, new ConnectError("Authentication required for authorization", Code.Unauthenticated));

        assert.ok(out instanceof CliError);
        assert.equal(out.message, "Reflection request to http://localhost:5000 failed: [unauthenticated] Authentication required for authorization");
    });

    it("returns an error that is already worded, and one that is not a Connect error, as it is", () => {
        const worded = new CliError("already worded");
        const defect = new TypeError("a defect");

        assert.equal(describeReflectionFailure(ADDRESS, worded), worded);
        assert.equal(describeReflectionFailure(ADDRESS, defect), defect);
        assert.equal(describeReflectionFailure(ADDRESS, "not even an error"), "not even an error");
    });

    it("does not loop on a cause chain that refers back to itself", () => {
        const a = new Error("a") as Error & { cause?: unknown };
        const b = new Error("b") as Error & { cause?: unknown };
        a.cause = b;
        b.cause = a;
        const out = describeReflectionFailure(ADDRESS, new ConnectError("", Code.Unavailable, undefined, undefined, a));

        assert.ok(out instanceof CliError);
        assert.match(out.message, /the server is unavailable/);
    });
});

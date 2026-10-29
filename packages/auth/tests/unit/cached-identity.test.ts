/**
 * Copies of a verified identity for the credential cache.
 *
 * The cache stores one copy per credential and gives every request its own copy of that, so a
 * copy must share no mutable state with the verifier's object, with the stored one or with the
 * copies handed to other requests.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { copyAuthContext } from "../../src/cached-identity.ts";
import type { AuthContext } from "../../src/types.ts";

function verified(): AuthContext {
    return { subject: "alice", name: "Alice", roles: ["user"], scopes: ["read"], claims: { tenant: "acme", nested: { flags: ["a"] } }, type: "jwt", expiresAt: new Date(2_000_000_000_000) };
}

describe("copyAuthContext", () => {
    it("keeps every value of the identity", () => {
        assert.deepStrictEqual(copyAuthContext(verified()), verified());
    });

    it("shares no mutable part with the original", () => {
        const original = verified();
        const copy = copyAuthContext(original);

        (copy.roles as string[]).push("admin");
        (copy.scopes as string[]).push("write");
        (copy.claims as Record<string, unknown>).tenant = "other";
        ((copy.claims.nested as { flags: string[] }).flags).push("x");
        copy.expiresAt?.setTime(0);

        assert.deepStrictEqual(original, verified());
    });

    it("gives two copies of one source independent state", () => {
        const stored = verified();
        const first = copyAuthContext(stored);
        const second = copyAuthContext(stored);
        (first.roles as string[]).push("admin");
        assert.deepStrictEqual(second.roles, ["user"]);
    });

    it("keeps a claim named __proto__ as data and leaves the prototype alone", () => {
        const claims = JSON.parse('{"__proto__":{"admin":true},"ok":1}') as Record<string, unknown>;
        const copy = copyAuthContext({ ...verified(), claims });

        assert.ok(Object.hasOwn(copy.claims, "__proto__"));
        assert.strictEqual(Object.getPrototypeOf(copy.claims), Object.prototype);
        assert.strictEqual(({} as { admin?: boolean }).admin, undefined);
    });

    it("copes with a cyclic claim, copies a Date and shares a class instance", () => {
        class Marker {}
        const marker = new Marker();
        const cyclic: Record<string, unknown> = { stamp: new Date(5), marker };
        cyclic.self = cyclic;
        const copy = copyAuthContext({ ...verified(), claims: cyclic });

        assert.strictEqual(copy.claims.self, copy.claims);
        assert.notStrictEqual(copy.claims.stamp, cyclic.stamp);
        assert.strictEqual((copy.claims.stamp as Date).getTime(), 5);
        assert.strictEqual(copy.claims.marker, marker);
    });

    it("omits expiresAt and name when the identity has none, and keeps extra keys", () => {
        const { expiresAt: _expiresAt, name: _name, ...rest } = verified();
        const copy = copyAuthContext({ ...rest, tenant: "acme" } as AuthContext);

        assert.ok(!("expiresAt" in copy));
        assert.ok(!("name" in copy));
        assert.strictEqual((copy as unknown as { tenant: string }).tenant, "acme");
    });
});

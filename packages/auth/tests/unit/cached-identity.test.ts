/**
 * Snapshots of a verified identity for the credential cache.
 *
 * The cache stores one snapshot per credential and hands every later request a view of it, so
 * the snapshot must not share mutable state with the verifier's object (the verifier may keep
 * it) nor with the requests (a handler may change it).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { snapshotAuthContext, viewOfSnapshot } from "../../src/cached-identity.ts";
import type { AuthContext } from "../../src/types.ts";

function verified(): AuthContext {
    return { subject: "alice", name: "Alice", roles: ["user"], scopes: ["read"], claims: { tenant: "acme", nested: { flags: ["a"] } }, type: "jwt", expiresAt: new Date(2_000_000_000_000) };
}

describe("snapshotAuthContext", () => {
    it("freezes the context, roles, scopes and every nested claim object and array", () => {
        const snapshot = snapshotAuthContext(verified());

        assert.ok(Object.isFrozen(snapshot));
        assert.ok(Object.isFrozen(snapshot.roles));
        assert.ok(Object.isFrozen(snapshot.scopes));
        assert.ok(Object.isFrozen(snapshot.claims));
        const nested = snapshot.claims.nested as { flags: string[] };
        assert.ok(Object.isFrozen(nested));
        assert.ok(Object.isFrozen(nested.flags));
        assert.throws(() => (snapshot.roles as string[]).push("admin"), TypeError);
        assert.throws(() => nested.flags.push("x"), TypeError);
    });

    it("keeps every value of the identity", () => {
        assert.deepStrictEqual(snapshotAuthContext(verified()), verified());
    });

    it("does not freeze or share the verifier's own objects", () => {
        const original = verified();
        const snapshot = snapshotAuthContext(original);

        assert.ok(!Object.isFrozen(original));
        assert.ok(!Object.isFrozen(original.roles));
        assert.ok(!Object.isFrozen(original.claims));
        (original.roles as string[]).push("added-later");
        (original.claims.nested as { flags: string[] }).flags.push("added-later");
        assert.deepStrictEqual(snapshot.roles, ["user"]);
        assert.deepStrictEqual(snapshot.claims.nested, { flags: ["a"] });
        original.expiresAt?.setTime(0);
        assert.strictEqual(snapshot.expiresAt?.getTime(), 2_000_000_000_000);
    });

    it("keeps a claim named __proto__ as data and leaves the prototype alone", () => {
        const claims = JSON.parse('{"__proto__":{"admin":true},"ok":1}') as Record<string, unknown>;
        const snapshot = snapshotAuthContext({ ...verified(), claims });

        assert.ok(Object.hasOwn(snapshot.claims, "__proto__"));
        assert.strictEqual(Object.getPrototypeOf(snapshot.claims), Object.prototype);
        assert.strictEqual(({} as { admin?: boolean }).admin, undefined);
    });

    it("copes with a cyclic claim and keeps non-plain values as they are", () => {
        const stamp = new Date(5);
        const cyclic: Record<string, unknown> = { stamp };
        cyclic.self = cyclic;
        const snapshot = snapshotAuthContext({ ...verified(), claims: cyclic });

        assert.strictEqual(snapshot.claims.self, snapshot.claims);
        assert.strictEqual(snapshot.claims.stamp, stamp);
    });

    it("omits expiresAt and name when the identity has none, and keeps extra keys", () => {
        const { expiresAt: _expiresAt, name: _name, ...rest } = verified();
        const snapshot = snapshotAuthContext({ ...rest, tenant: "acme" } as AuthContext);

        assert.ok(!("expiresAt" in snapshot));
        assert.ok(!("name" in snapshot));
        assert.strictEqual((snapshot as unknown as { tenant: string }).tenant, "acme");
    });
});

describe("viewOfSnapshot", () => {
    it("is frozen, shares the frozen parts and owns its expiry", () => {
        const snapshot = snapshotAuthContext(verified());
        const view = viewOfSnapshot(snapshot);

        assert.ok(Object.isFrozen(view));
        assert.strictEqual(view.roles, snapshot.roles);
        assert.strictEqual(view.claims, snapshot.claims);
        assert.notStrictEqual(view.expiresAt, snapshot.expiresAt);
        view.expiresAt?.setTime(0);
        assert.strictEqual(snapshot.expiresAt?.getTime(), 2_000_000_000_000, "a handler cannot move the stored expiry");
        assert.strictEqual(viewOfSnapshot(snapshot).expiresAt?.getTime(), 2_000_000_000_000);
    });
});

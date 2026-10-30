/**
 * Copies of a verified identity for the credential cache.
 *
 * The cache stores one copy per credential and gives every request its own copy of that, so a
 * copy must share no mutable state with the verifier's object, with the stored one or with the
 * copies handed to other requests.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { copyAuthContext } from "../../src/cached-identity.ts";
import { getAuthContext } from "../../src/context.ts";
import type { AuthContext } from "../../src/types.ts";

/** A fresh identity as a verifier returns it, with nested claims and an expiry. */
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
        /** A claim value that is neither a plain object nor an array, so it must be shared, not copied. */
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

    it("copies a context whose fields are getters on a class prototype", () => {
        /** An identity whose required fields live on the prototype, where an object spread does not see them. */
        class Session {
            get subject() {
                return "alice";
            }
            get type() {
                return "session";
            }
            get name() {
                return "Alice";
            }
            roles = ["user"];
            scopes = ["read"];
            claims = { tenant: "acme" };
        }
        const copy = copyAuthContext(new Session());

        assert.strictEqual(copy.subject, "alice");
        assert.strictEqual(copy.type, "session");
        assert.strictEqual(copy.name, "Alice");
        assert.deepStrictEqual(copy.roles, ["user"]);
    });

    it("serves two consecutive requests with such a context through the cache, with headers propagated", async () => {
        /** An identity whose subject and type are prototype getters, returned fresh by every verification. */
        class Session {
            get subject() {
                return "alice";
            }
            get type() {
                return "session";
            }
            roles = ["user"];
            scopes = ["read"];
            claims = {};
        }
        const seen: Array<string | undefined> = [];
        const interceptor = createAuthInterceptor({ verifyCredentials: async () => new Session(), cache: { ttl: 60_000 }, propagateHeaders: true });
        for (let i = 0; i < 2; i++) {
            const req = createMockRequest({ service: "t.v1.S", method: "M", headers: new Headers({ authorization: "Bearer t" }) });
            await interceptor((async () => {
                seen.push(getAuthContext()?.subject);
                return { message: {} };
            }) as never)(req);
            assert.strictEqual(req.header.get("x-auth-subject"), "alice");
        }
        assert.deepStrictEqual(seen, ["alice", "alice"]);
    });

    it("copies an array by its items, not by a custom iterator it carries", async () => {
        const make = (): string[] => {
            const list = ["user"];
            Object.defineProperty(list, Symbol.iterator, { value: () => ["admin"][Symbol.iterator]() });
            return list;
        };
        const copy = copyAuthContext({ ...verified(), roles: make(), scopes: make(), claims: { groups: make() } });

        assert.deepStrictEqual([...Array.prototype.values.call(copy.roles)], ["user"]);
        assert.deepStrictEqual(Array.from({ length: copy.scopes.length }, (_, index) => copy.scopes[index]), ["user"]);
        assert.deepStrictEqual(Array.from({ length: (copy.claims.groups as string[]).length }, (_, index) => (copy.claims.groups as string[])[index]), ["user"]);
        assert.strictEqual(copy.roles.includes("admin"), false);

        const seen: string[][] = [];
        const interceptor = createAuthInterceptor({ verifyCredentials: async () => ({ ...verified(), roles: make() }), cache: { ttl: 60_000 } });
        for (let i = 0; i < 2; i++) {
            await interceptor((async () => {
                seen.push([...(getAuthContext()?.roles ?? [])].length ? Array.from({ length: getAuthContext()?.roles.length ?? 0 }, (_, index) => getAuthContext()?.roles[index] ?? "") : []);
                return { message: {} };
            }) as never)(createMockRequest({ service: "t.v1.S", method: "M", headers: new Headers({ authorization: "Bearer t" }) }));
        }
        assert.deepStrictEqual(seen, [["user"], ["user"]]);
    });

    it("keeps the holes of a sparse array in claims", () => {
        // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
        const sparse = ["a", , "c"];
        const copy = copyAuthContext({ ...verified(), claims: { list: sparse } });
        const list = copy.claims.list as unknown[];

        assert.strictEqual(list.length, 3);
        assert.strictEqual(1 in list, false, "the hole stays a hole");
        assert.strictEqual(list[0], "a");
        assert.strictEqual(list[2], "c");
    });

    it("omits expiresAt and name when the identity has none, and keeps extra keys", () => {
        const { expiresAt: _expiresAt, name: _name, ...rest } = verified();
        const copy = copyAuthContext({ ...rest, tenant: "acme" } as AuthContext);

        assert.ok(!("expiresAt" in copy));
        assert.ok(!("name" in copy));
        assert.strictEqual((copy as unknown as { tenant: string }).tenant, "acme");
    });
});

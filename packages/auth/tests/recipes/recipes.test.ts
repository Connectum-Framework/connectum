/**
 * Each engine recipe sends the exact request its official API documents and reads only the
 * documented positive answer as allow. The transport is a recording stub, so the body is compared
 * literally.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AuthContext, ResourceCheck } from "../../src/types.ts";
import { createCedarAuthorizer, type IsAuthorizedInput } from "./cedar.ts";
import { createCerbosAuthorizer } from "./cerbos.ts";
import type { FetchLike } from "./http.ts";
import { createOpaAuthorizer } from "./opa.ts";
import { createOpenFgaAuthorizer } from "./openfga.ts";
import { createSpiceDbAuthorizer } from "./spicedb.ts";

const subject: AuthContext = { subject: "alice", roles: ["editor"], scopes: ["docs:write"], claims: {}, type: "test" };
const input: ResourceCheck = {
    subject,
    action: "update",
    resource: { type: "doc", id: "d1" },
    context: { service: "docs.v1.DocService", method: "Update", message: { $typeName: "docs.v1.UpdateRequest" } },
};

interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

/** A fetch that records the request and answers with `reply` and `status`. */
function stub(reply: unknown, status = 200) {
    const sent: Sent[] = [];
    const fetch: FetchLike = async (url, init) => {
        sent.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        return { ok: status >= 200 && status < 300, status, json: async () => reply };
    };
    return { fetch, sent };
}

describe("OpenFGA recipe", () => {
    it("sends the Check body and allows on allowed: true", async () => {
        const { fetch, sent } = stub({ allowed: true });
        const decision = await createOpenFgaAuthorizer({ apiUrl: "http://fga:8080", storeId: "01ARZ", authorizationModelId: "01GXS", fetch }).check(input);
        assert.strictEqual(decision, "allow");
        assert.deepStrictEqual(sent, [
            {
                url: "http://fga:8080/stores/01ARZ/check",
                method: "POST",
                headers: { "content-type": "application/json" },
                body: { tuple_key: { user: "user:alice", relation: "update", object: "doc:d1" }, authorization_model_id: "01GXS" },
            },
        ]);
    });

    it("omits the model id when none is pinned and sends the authorization header", async () => {
        const { fetch, sent } = stub({ allowed: false });
        const decision = await createOpenFgaAuthorizer({ apiUrl: "http://fga:8080", storeId: "s", authorization: "Bearer t", fetch }).check(input);
        assert.strictEqual(decision, "deny");
        assert.deepStrictEqual(sent[0]?.body, { tuple_key: { user: "user:alice", relation: "update", object: "doc:d1" } });
        assert.strictEqual(sent[0]?.headers.authorization, "Bearer t");
    });

    it('denies anything but allowed: true (a string "true" is not true)', async () => {
        const { fetch } = stub({ allowed: "true" });
        assert.strictEqual(await createOpenFgaAuthorizer({ apiUrl: "http://fga", storeId: "s", fetch }).check(input), "deny");
    });
});

describe("SpiceDB recipe", () => {
    it("sends CheckPermission and allows on PERMISSIONSHIP_HAS_PERMISSION", async () => {
        const { fetch, sent } = stub({ permissionship: "PERMISSIONSHIP_HAS_PERMISSION" });
        const decision = await createSpiceDbAuthorizer({ endpoint: "http://spicedb:8443", presharedKey: "k", fetch }).check(input);
        assert.strictEqual(decision, "allow");
        assert.deepStrictEqual(sent, [
            {
                url: "http://spicedb:8443/v1/permissions/check",
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer k" },
                body: {
                    consistency: { minimizeLatency: true },
                    resource: { objectType: "doc", objectId: "d1" },
                    permission: "update",
                    subject: { object: { objectType: "user", objectId: "alice" } },
                },
            },
        ]);
    });

    for (const permissionship of ["PERMISSIONSHIP_NO_PERMISSION", "PERMISSIONSHIP_CONDITIONAL_PERMISSION", "PERMISSIONSHIP_UNSPECIFIED"]) {
        it(`denies ${permissionship}`, async () => {
            const { fetch } = stub({ permissionship });
            assert.strictEqual(await createSpiceDbAuthorizer({ endpoint: "http://s", presharedKey: "k", fetch }).check(input), "deny");
        });
    }
});

describe("OPA recipe", () => {
    it("wraps the input and allows on result: true", async () => {
        const { fetch, sent } = stub({ result: true });
        const decision = await createOpaAuthorizer({ baseUrl: "http://opa:8181", policyPath: "connectum/authz/allow", fetch }).check(input);
        assert.strictEqual(decision, "allow");
        assert.deepStrictEqual(sent, [
            {
                url: "http://opa:8181/v1/data/connectum/authz/allow",
                method: "POST",
                headers: { "content-type": "application/json" },
                body: {
                    input: {
                        subject: { id: "alice", roles: ["editor"], scopes: ["docs:write"] },
                        action: "update",
                        resource: { type: "doc", id: "d1" },
                        context: { service: "docs.v1.DocService", method: "Update" },
                    },
                },
            },
        ]);
    });

    it("denies when the reply has no result (undefined document)", async () => {
        const { fetch } = stub({});
        assert.strictEqual(await createOpaAuthorizer({ baseUrl: "http://opa", policyPath: "p", fetch }).check(input), "deny");
    });

    it("denies a result that is not the boolean true", async () => {
        const { fetch } = stub({ result: { allow: true } });
        assert.strictEqual(await createOpaAuthorizer({ baseUrl: "http://opa", policyPath: "p", fetch }).check(input), "deny");
    });
});

describe("Cedar (Verified Permissions) recipe", () => {
    const seen: IsAuthorizedInput[] = [];
    const make = (decision: unknown) =>
        createCedarAuthorizer({
            policyStoreId: "PSEXAMPLEabcdefg111111",
            principalType: "PhotoFlash::User",
            actionType: "PhotoFlash::Action",
            entityTypes: { doc: "PhotoFlash::Photo" },
            isAuthorized: async (request) => {
                seen.push(request);
                return { decision };
            },
        });

    it("sends IsAuthorized and allows on ALLOW", async () => {
        seen.length = 0;
        assert.strictEqual(await make("ALLOW").check(input), "allow");
        assert.deepStrictEqual(seen, [
            {
                policyStoreId: "PSEXAMPLEabcdefg111111",
                principal: { entityType: "PhotoFlash::User", entityId: "alice" },
                action: { actionType: "PhotoFlash::Action", actionId: "update" },
                resource: { entityType: "PhotoFlash::Photo", entityId: "d1" },
            },
        ]);
    });

    it("denies DENY and anything else", async () => {
        assert.strictEqual(await make("DENY").check(input), "deny");
        assert.strictEqual(await make("Allow").check(input), "deny");
    });
});

describe("Cerbos recipe", () => {
    it("sends check/resources and allows on EFFECT_ALLOW for the action", async () => {
        const { fetch, sent } = stub({ results: [{ resource: { kind: "doc", id: "d1" }, actions: { update: "EFFECT_ALLOW" } }] });
        const decision = await createCerbosAuthorizer({ baseUrl: "http://cerbos:3592", fetch }).check(input);
        assert.strictEqual(decision, "allow");
        assert.deepStrictEqual(sent, [
            {
                url: "http://cerbos:3592/api/check/resources",
                method: "POST",
                headers: { "content-type": "application/json" },
                body: {
                    principal: { id: "alice", roles: ["editor"], attr: { scopes: ["docs:write"] } },
                    resources: [{ resource: { kind: "doc", id: "d1" }, actions: ["update"] }],
                },
            },
        ]);
    });

    it("denies EFFECT_DENY and a reply without the action", async () => {
        for (const reply of [{ results: [{ actions: { update: "EFFECT_DENY" } }] }, { results: [{ actions: {} }] }, {}]) {
            const { fetch } = stub(reply);
            assert.strictEqual(await createCerbosAuthorizer({ baseUrl: "http://c", fetch }).check(input), "deny");
        }
    });
});

describe("engine outage", () => {
    it("an error status becomes ConnectError Unavailable without the engine text", async () => {
        const { fetch } = stub({ error: "secret" }, 503);
        await assert.rejects(
            () => createOpenFgaAuthorizer({ apiUrl: "http://fga", storeId: "s", fetch }).check(input),
            (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable && !error.message.includes("secret"),
        );
    });

    it("a network failure becomes ConnectError Unavailable", async () => {
        const fetch: FetchLike = async () => {
            throw new Error("ECONNREFUSED");
        };
        await assert.rejects(
            () => createOpaAuthorizer({ baseUrl: "http://opa", policyPath: "p", fetch }).check(input),
            (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable,
        );
    });
});

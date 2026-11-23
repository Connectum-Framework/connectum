/**
 * Where the resource gate runs: every outcome of the method-level decision of
 * `createProtoAuthzInterceptor`, with a resource rule declared on the method, under both default
 * policies.
 *
 * A method-level denial never reaches the authorizer. Every allowing outcome does, and only the
 * authorizer's answer then lets the handler run. The one outcome the rule changes is the denial by
 * `defaultPolicy: "deny"`: a declared resource rule is the requirement, so the gate decides there.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import type { ProtoAuthzInterceptorOptions } from "../../src/types.ts";
import { caller, READ_DOC, type RunOptions, run, trustedInternalCaller } from "../helpers/resource-gate-harness.ts";

const SERVICE = "test.resource.v1.ResourceService";

interface Row {
    readonly name: string;
    readonly auth: NonNullable<RunOptions["method"]["auth"]>;
    readonly serviceAuth?: RunOptions["serviceAuth"];
    readonly interceptor?: ProtoAuthzInterceptorOptions;
    readonly subject?: RunOptions["subject"];
    /** "gate": the method-level decision allows and the authorizer decides. "deny": refused before the gate. */
    readonly outcome: "gate" | "deny";
}

const rows: readonly Row[] = [
    { name: "internal method, trusted internal caller", auth: { internal: true, resources: READ_DOC }, subject: trustedInternalCaller(), outcome: "gate" },
    { name: "requires satisfied", auth: { requires: { roles: ["editor"] }, resources: READ_DOC }, subject: { ...caller, roles: ["editor"] }, outcome: "gate" },
    { name: "requires not satisfied", auth: { requires: { roles: ["editor"] }, resources: READ_DOC }, outcome: "deny" },
    { name: "policy allow", auth: { policy: "allow", resources: READ_DOC }, outcome: "gate" },
    { name: "policy deny", auth: { policy: "deny", resources: READ_DOC }, outcome: "deny" },
    { name: "inherited service default deny", auth: { resources: READ_DOC }, serviceAuth: { defaultPolicy: "deny" }, outcome: "gate" },
    { name: "own policy deny under a service default allow", auth: { policy: "deny", resources: READ_DOC }, serviceAuth: { defaultPolicy: "allow" }, outcome: "deny" },
    { name: "own policy deny under a service default deny", auth: { policy: "deny", resources: READ_DOC }, serviceAuth: { defaultPolicy: "deny" }, outcome: "deny" },
    {
        name: "inherited service default deny with a denying programmatic rule",
        auth: { resources: READ_DOC },
        serviceAuth: { defaultPolicy: "deny" },
        interceptor: { rules: [{ name: "closed", methods: [`${SERVICE}/*`], effect: "deny" }] },
        outcome: "deny",
    },
    {
        name: "programmatic rule allows",
        auth: { resources: READ_DOC },
        interceptor: { rules: [{ name: "open", methods: [`${SERVICE}/*`], effect: "allow" }] },
        outcome: "gate",
    },
    {
        name: "programmatic rule denies",
        auth: { resources: READ_DOC },
        interceptor: { rules: [{ name: "closed", methods: [`${SERVICE}/*`], effect: "deny" }] },
        outcome: "deny",
    },
    { name: "authorize returns true", auth: { resources: READ_DOC }, interceptor: { authorize: () => true }, outcome: "gate" },
    { name: "authorize returns false", auth: { resources: READ_DOC }, interceptor: { authorize: () => false }, outcome: "deny" },
    { name: "authorize returns a truthy non-boolean", auth: { resources: READ_DOC }, interceptor: { authorize: (() => "yes") as never }, outcome: "deny" },
    { name: "nothing else declared (decided by the default policy alone)", auth: { resources: READ_DOC }, outcome: "gate" },
];

for (const defaultPolicy of ["deny", "allow"] as const) {
    describe(`resource gate placement, defaultPolicy "${defaultPolicy}"`, () => {
        for (const row of rows) {
            if (row.outcome === "gate") {
                it(`${row.name}: the authorizer decides, an allow runs the handler`, async () => {
                    const result = await run({ method: { input: "DocRequest", auth: row.auth }, ...(row.serviceAuth !== undefined && { serviceAuth: row.serviceAuth }), interceptor: { defaultPolicy, ...row.interceptor }, subject: row.subject ?? caller, authorizer: "allow" });
                    assert.strictEqual(result.code, undefined);
                    assert.strictEqual(result.handled, 1);
                    assert.strictEqual(result.asked.length, 1);
                });
                it(`${row.name}: an authorizer deny stops the call with PermissionDenied`, async () => {
                    const result = await run({ method: { input: "DocRequest", auth: row.auth }, ...(row.serviceAuth !== undefined && { serviceAuth: row.serviceAuth }), interceptor: { defaultPolicy, ...row.interceptor }, subject: row.subject ?? caller, authorizer: "deny" });
                    assert.strictEqual(result.code, Code.PermissionDenied);
                    assert.strictEqual(result.handled, 0);
                    assert.strictEqual(result.asked.length, 1);
                });
            } else {
                it(`${row.name}: refused before the gate, the authorizer is not asked`, async () => {
                    const result = await run({ method: { input: "DocRequest", auth: row.auth }, ...(row.serviceAuth !== undefined && { serviceAuth: row.serviceAuth }), interceptor: { defaultPolicy, ...row.interceptor }, subject: row.subject ?? caller, authorizer: "allow" });
                    assert.strictEqual(result.code, Code.PermissionDenied);
                    assert.strictEqual(result.handled, 0);
                    assert.strictEqual(result.asked.length, 0);
                });
            }
        }
    });
}

describe("resource rule as the only requirement", () => {
    it("an unauthenticated call fails with Unauthenticated and the authorizer is not asked", async () => {
        const result = await run({ method: { input: "DocRequest", auth: { resources: READ_DOC } }, interceptor: { defaultPolicy: "deny" }, subject: null });
        assert.strictEqual(result.code, Code.Unauthenticated);
        assert.strictEqual(result.asked.length, 0);
        assert.strictEqual(result.handled, 0);
    });

    it("a method without a resource rule is still denied by defaultPolicy deny", async () => {
        const result = await run({ method: { input: "DocRequest" }, interceptor: { defaultPolicy: "deny" } });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.asked.length, 0);
    });

    it("a method without a resource rule never reaches the authorizer under defaultPolicy allow", async () => {
        const result = await run({ method: { input: "DocRequest" }, interceptor: { defaultPolicy: "allow" } });
        assert.strictEqual(result.code, undefined);
        assert.strictEqual(result.handled, 1);
        assert.strictEqual(result.asked.length, 0);
    });
});

describe("resource rule behind a role", () => {
    it("a caller without the role fails with PermissionDenied and the authorizer is not asked", async () => {
        const result = await run({ method: { input: "DocRequest", auth: { requires: { roles: ["editor"] }, resources: READ_DOC } } });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.asked.length, 0);
    });

    it("a caller with the role is still stopped by an authorizer deny", async () => {
        const result = await run({ method: { input: "DocRequest", auth: { requires: { roles: ["editor"] }, resources: READ_DOC } }, subject: { ...caller, roles: ["editor"] }, authorizer: "deny" });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.handled, 0);
    });
});

describe("internal method with a resource rule", () => {
    it("an untrusted identity fails with Unauthenticated before the gate", async () => {
        const result = await run({ method: { input: "DocRequest", auth: { internal: true, resources: READ_DOC } } });
        assert.strictEqual(result.code, Code.Unauthenticated);
        assert.strictEqual(result.asked.length, 0);
    });
});

/**
 * Reading and validating the `resources` rules of a method: what is accepted, what the contract
 * author is told when it is not, and that the result is cached.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { ResolvedMethodAuth } from "../../src/proto/reader.ts";
import { resolveMethodAuth } from "../../src/proto/reader.ts";
import { ResourceRuleError } from "../../src/proto/resource-rules.ts";
import { caller, run } from "../helpers/resource-gate-harness.ts";
import { buildResourceService, type ResourceMethodSpec } from "../helpers/resource-test-helpers.ts";

type Rule = NonNullable<NonNullable<ResourceMethodSpec["auth"]>["resources"]>[number];

/** Resolve a single method built from `spec`. */
function resolve(spec: ResourceMethodSpec, serviceAuth?: { public?: boolean; defaultPolicy?: string }) {
    const { methods } = buildResourceService({ Call: spec }, serviceAuth);
    return resolveMethodAuth(methods.Call as NonNullable<typeof methods.Call>);
}

/** Assert that reading throws a ResourceRuleError whose text contains every fragment. */
function refuses(spec: ResourceMethodSpec, fragments: string[], serviceAuth?: { public?: boolean }) {
    assert.throws(
        () => resolve(spec, serviceAuth),
        (error: unknown) => {
            assert.ok(error instanceof ResourceRuleError, `expected ResourceRuleError, got ${String(error)}`);
            for (const fragment of ["ResourceService/Call", ...fragments]) {
                assert.ok(error.message.includes(fragment), `"${fragment}" missing from: ${error.message}`);
            }
            return true;
        },
    );
}

const rule = (override: Partial<Record<keyof Rule, unknown>> = {}): Rule => ({ action: "read", idField: "id", type: "doc", ...override }) as Rule;
const unary = (...resources: Rule[]): ResourceMethodSpec => ({ input: "DocRequest", auth: { resources } });

describe("resolveMethodAuth: resources", () => {
    it("resolves a fixed-type rule", () => {
        const resolved = resolve(unary(rule()));
        assert.deepStrictEqual(resolved.resources, [{ action: "read", idField: "id", type: "doc", typeField: undefined, types: [] }]);
    });

    it("resolves a rule that reads the type from the request", () => {
        const resolved = resolve({ input: "MoveRequest", auth: { resources: [{ action: "create_child", idField: "target.id", typeField: "target.type", types: ["project", "task"] }] } });
        assert.deepStrictEqual(resolved.resources, [{ action: "create_child", idField: "target.id", type: undefined, typeField: "target.type", types: ["project", "task"] }]);
    });

    it("keeps several rules in declaration order", () => {
        const resolved = resolve(unary(rule({ action: "a" }), rule({ action: "b" })));
        assert.deepStrictEqual(
            resolved.resources?.map((entry) => entry.action),
            ["a", "b"],
        );
    });

    it("leaves `resources` absent on a method without rules, so existing resolutions keep their shape", () => {
        const resolved = resolve({ input: "DocRequest", auth: { requires: { roles: ["admin"] } } });
        assert.strictEqual("resources" in resolved, false);
    });

    it("accepts a server-streaming method", () => {
        const resolved = resolve({ input: "DocRequest", kind: "server", auth: { resources: [rule()] } });
        assert.strictEqual(resolved.resources?.length, 1);
    });

    it("caches the resolution per method descriptor", () => {
        const { methods } = buildResourceService({ Call: unary(rule()) });
        const method = methods.Call as NonNullable<typeof methods.Call>;
        assert.strictEqual(resolveMethodAuth(method), resolveMethodAuth(method));
    });

    it("lets a ResolvedMethodAuth double written without `resources` compile and resolve", () => {
        const double: ResolvedMethodAuth = { public: false, internal: false, policy: undefined, requires: undefined };
        assert.strictEqual(double.resources, undefined);
    });
});

describe("resolveMethodAuth: a resource rule must be resolvable", () => {
    it("refuses both type forms", () => {
        refuses(unary(rule({ typeField: "kind", types: ["doc"] })), ["resources[0]", "exactly one of"]);
    });

    it("refuses neither type form", () => {
        refuses(unary(rule({ type: "" })), ["resources[0]", "neither is set"]);
    });

    it("refuses type_field without allowed types", () => {
        refuses(unary(rule({ type: "", typeField: "kind" })), ["resources[0]", "types"]);
    });

    it("refuses a fixed type together with types", () => {
        refuses(unary(rule({ types: ["doc"] })), ["resources[0]", "type_field"]);
    });

    it("refuses an empty entry in types", () => {
        refuses(unary(rule({ type: "", typeField: "kind", types: ["doc", ""] })), ["empty string"]);
    });

    it("refuses an empty action and names the rule index", () => {
        refuses(unary(rule(), rule({ action: "" })), ["resources[1]", "action"]);
    });

    it("refuses an empty id path", () => {
        refuses(unary(rule({ idField: "" })), ["resources[0]", "id_field"]);
    });

    it("refuses an id path to a field the request does not have, naming the path", () => {
        refuses(unary(rule({ idField: "taks_id" })), ["taks_id"]);
    });

    it("refuses a type path to a field the request does not have", () => {
        refuses(unary(rule({ type: "", typeField: "knd", types: ["doc"] })), ["knd"]);
    });

    it("refuses a generated local name: paths use proto field names", () => {
        refuses({ input: "OneofRequest", auth: { resources: [rule({ idField: "target.taskId" })] } }, ["target.taskId"]);
    });

    it("refuses a path to a field that is not a string", () => {
        refuses(unary(rule({ idField: "count" })), ["count", "string"]);
    });

    it("refuses a path that ends at a message", () => {
        refuses({ input: "MoveRequest", auth: { resources: [rule({ idField: "source" })] } }, ["source", "string"]);
    });

    it("refuses a path that continues past a string field", () => {
        refuses(unary(rule({ idField: "id.more" })), ["id.more"]);
    });

    it("refuses a path through a repeated field", () => {
        refuses({ input: "ListRequest", auth: { resources: [rule({ idField: "items.id" })] } }, ["items.id", "repeated"]);
    });

    it("refuses a path through a map field", () => {
        refuses({ input: "ListRequest", auth: { resources: [rule({ idField: "labels.key" })] } }, ["labels.key", "map"]);
    });

    it("accepts a path into a oneof member", () => {
        const resolved = resolve({ input: "OneofRequest", auth: { resources: [rule({ idField: "target.task_id" })] } });
        assert.strictEqual(resolved.resources?.[0]?.idField, "target.task_id");
    });
});

describe("resolveMethodAuth: where resource rules are allowed", () => {
    it("refuses a rule on a method that is public", () => {
        refuses({ input: "DocRequest", auth: { public: true, resources: [rule()] } }, ["public"]);
    });

    it("names both conflicting settings, the resource rules and public, when refusing a public method", () => {
        refuses({ input: "DocRequest", auth: { public: true, resources: [rule()] } }, ["resource rules", "public"]);
    });

    it("refuses a rule on a method that inherits public from its service", () => {
        refuses(unary(rule()), ["public", "inherited"], { public: true });
    });

    it("accepts a rule on a method that overrides a public service with public: false", () => {
        const resolved = resolve({ input: "DocRequest", auth: { public: false, resources: [rule()] } }, { public: true });
        assert.strictEqual(resolved.resources?.length, 1);
    });

    it("refuses a rule on a client-streaming method", () => {
        refuses({ input: "DocRequest", kind: "client", auth: { resources: [rule()] } }, ["client-streaming"]);
    });

    it("refuses a rule on a bidirectional-streaming method", () => {
        refuses({ input: "DocRequest", kind: "bidi", auth: { resources: [rule()] } }, ["bidirectional-streaming"]);
    });

    it("does not cache a failed resolution", () => {
        const { methods } = buildResourceService({ Call: unary(rule({ idField: "nope" })) });
        const method = methods.Call as NonNullable<typeof methods.Call>;
        assert.throws(() => resolveMethodAuth(method), ResourceRuleError);
        assert.throws(() => resolveMethodAuth(method), ResourceRuleError);
    });
});

describe("services: eager validation", () => {
    it("throws at creation naming the method and the field when a rule cannot be resolved", () => {
        const { service } = buildResourceService({ Call: unary(rule({ idField: "taks_id" })) });
        assert.throws(
            () => createProtoAuthzInterceptor({ services: [service] }),
            (error: unknown) => error instanceof ResourceRuleError && error.message.includes("ResourceService/Call") && error.message.includes("taks_id"),
        );
    });

    it("creates the interceptor when every method resolves", () => {
        const { service } = buildResourceService({ Call: unary(rule()) });
        assert.doesNotThrow(() => createProtoAuthzInterceptor({ services: [service] }));
    });

    it("without services, a rule that cannot be resolved ends the call with Internal and the reason stays in the log", async () => {
        const result = await run({ method: unary(rule({ idField: "taks_id" })), subject: caller });
        assert.strictEqual(result.code, Code.Internal);
        const error = result.error as ConnectError;
        assert.ok(!error.rawMessage.includes("taks_id"), "the contract field must not reach the client");
        assert.strictEqual(result.logged.error.length, 1);
        assert.match(result.logged.error[0] as string, /ResourceService\/Call/);
        assert.strictEqual(result.asked.length, 0);
    });
});
